/**
 * CompactNudgeRunner — subscribes to the main pi AgentSession's event
 * stream and, after each turn, checks whether context_percent has
 * crossed `thresholdPercent`. If it has, it defers a session.compact()
 * call via queueMicrotask so pi's post-turn state fully settles before
 * the compaction starts.
 *
 * Design notes:
 *   - Single-in-flight guarantee: a second nudge will not start while
 *     one is already running (inFlight guard).
 *   - Respects pi's own compacting/streaming state (isCompacting /
 *     isStreaming guards accessed via unsafe cast — those props exist at
 *     runtime but are not in pi's public TypeScript surface).
 *   - After a compact failure, backs off for `failureCooldownMs` to
 *     avoid hammering a struggling vLLM backend.
 *   - Records to compact_events via ContextTelemetryRecorder when the
 *     telemetry binding is set. Works silently without it.
 *   - Instructions are capped at INSTRUCTIONS_CAP chars before being
 *     forwarded to session.compact() regardless of config maxLength. The
 *     truncation is SILENT, so treat the cap as a hard authoring limit.
 */

import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { getBoundTelemetryRecorder } from "../telemetry/binding";

// Raised from 500 to 2000. The cap is applied as a silent
// .slice(), so an over-long value is truncated mid-sentence with no warning —
// and the last sentence of a compaction instruction is usually the one
// carrying the actual behavioural steer. 500 was not enough to say both what
// to keep and HOW to write it: one agent needs "preserve verbatim quotes of
// voice-critical material" alongside the keep/drop lists, and at 495 chars it
// had no room. 2000 is still far below anything that would meaningfully
// crowd the summarisation prompt.
const INSTRUCTIONS_CAP = 2000;
const DEFAULT_THRESHOLD_PERCENT = 70;
const DEFAULT_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

export interface CompactNudgeRunnerOptions {
  session: AgentSession;
  agentId: string;
  /** 0–100, defaults to 70. */
  thresholdPercent?: number;
  /**
   * Absolute context cap in tokens (`spindle.compact.context_limit`).
   * Fires when context tokens >= contextLimit,
   * independent of percent. Belt-and-suspenders trigger for cases where
   * the provider reports a misleading contextWindow (e.g. github-copilot
   * claude-sonnet-4.6 reports 1M but practical operating size is lower).
   * Either threshold crossing fires the nudge; whichever crosses first wins.
   */
  contextLimit?: number;
  /** Static focus instructions forwarded to session.compact(). */
  instructions?: string;
  /** Ms to pause after a compact failure before retrying. Default 300_000. */
  failureCooldownMs?: number;
  /** Emit a debug line every agent_end describing what the runner saw. */
  verbose?: boolean;
  /** Injectable clock for testing. Default Date.now. */
  now?: () => number;
}

/** Narrow view of the undocumented pi session state flags. */
interface SessionStateView {
  isCompacting?: boolean;
  isStreaming?: boolean;
  setAutoCompactionEnabled?: (enabled: boolean) => void;
}

/** Narrow view of getContextUsage() return shape. */
interface ContextUsage {
  tokens: number | null;
  percent: number | null;
  contextWindow: number;
}

export class CompactNudgeRunner {
  private readonly session: AgentSession;
  private readonly agentId: string;
  private readonly thresholdPercent: number;
  private readonly contextLimit: number | null;
  private readonly instructions: string | undefined;
  private readonly failureCooldownMs: number;
  private readonly verbose: boolean;
  private readonly nowFn: () => number;

  private unsubscribe: (() => void) | null = null;
  private inFlight = false;
  private lastFailureAt: number | null = null;

  constructor(opts: CompactNudgeRunnerOptions) {
    this.session = opts.session;
    this.agentId = opts.agentId;
    this.thresholdPercent = opts.thresholdPercent ?? DEFAULT_THRESHOLD_PERCENT;
    this.contextLimit = opts.contextLimit ?? null;
    this.instructions = opts.instructions?.slice(0, INSTRUCTIONS_CAP);
    this.failureCooldownMs = opts.failureCooldownMs ?? DEFAULT_FAILURE_COOLDOWN_MS;
    this.verbose = opts.verbose ?? false;
    this.nowFn = opts.now ?? Date.now;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.session.subscribe((event) => {
      try {
        this.onEvent(event);
      } catch (err) {
        console.warn(
          `[compact] runner event handler threw: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    });
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /**
   * Call once at boot when `auto_toggle_pi_native` is set in config.
   * Disabling pi-native auto-compact prevents double-compaction when the
   * nudge runner is the sole compaction driver; enabling it (re-enable
   * after a previous disable) restores pi's safety-net behavior.
   */
  setAutoCompactionEnabled(enabled: boolean): void {
    const s = this.session as unknown as SessionStateView;
    if (typeof s.setAutoCompactionEnabled === "function") {
      s.setAutoCompactionEnabled(enabled);
    } else {
      console.warn("[compact] session.setAutoCompactionEnabled not available — pi version may not support it");
    }
  }

  private onEvent(event: AgentSessionEvent): void {
    if (event.type !== "agent_end") return;
    this.considerNudge();
  }

  private considerNudge(): void {
    const s = this.session as unknown as SessionStateView;
    const usage = this.safeGetContextUsage();

    // Each gate has a label so the verbose log explains exactly why a turn
    // didn't fire — invaluable when diagnosing "runner should have fired"
    // type bugs (e.g. percent below threshold but contextLimit crossed).
    let reason: string | null = null;
    let trigger: "percent" | "tokens" | null = null;

    // Note: pi's `isStreaming` flag is often still true when `agent_end`
    // fires — pi clears it on a later tick. We don't gate on isStreaming
    // because the agent_end event is itself the end-of-turn signal.
    // Gating on it made the runner skip every turn
    // even when context_percent crossed the configured threshold.
    if (this.inFlight) {
      reason = "inFlight";
    } else if (s.isCompacting) {
      reason = "isCompacting";
    } else if (
      this.lastFailureAt !== null &&
      this.nowFn() - this.lastFailureAt < this.failureCooldownMs
    ) {
      reason = "cooldown";
    } else if (!usage) {
      reason = "no_usage";
    } else if (
      this.contextLimit !== null &&
      usage.tokens !== null &&
      usage.tokens >= this.contextLimit
    ) {
      trigger = "tokens";
    } else if (
      usage.percent !== null &&
      usage.percent >= this.thresholdPercent
    ) {
      trigger = "percent";
    } else if (usage.percent === null) {
      reason = "null_percent";
    } else {
      reason = "below_threshold";
    }

    if (this.verbose) {
      const tokens = usage?.tokens ?? null;
      const percent = usage?.percent ?? null;
      const cw = usage?.contextWindow ?? null;
      console.log(
        `[compact] turn observe — tokens=${tokens} percent=${percent !== null ? percent.toFixed(2) : "null"} window=${cw} ` +
          `thresholds(percent=${this.thresholdPercent}%, tokens=${this.contextLimit ?? "off"}) ` +
          `state(inFlight=${this.inFlight}, isCompacting=${Boolean(s.isCompacting)}, isStreaming=${Boolean(s.isStreaming)}) ` +
          `decision=${trigger ? `FIRE(${trigger})` : `skip(${reason})`}`
      );
    }

    if (!trigger || !usage) return;

    this.inFlight = true;
    const firePercent = usage.percent ?? 0;
    const fireTokens = usage.tokens ?? 0;
    const fireTrigger = trigger;
    queueMicrotask(() => {
      void this.runCompact(firePercent, fireTokens, fireTrigger);
    });
  }

  private async runCompact(
    observedPercent: number,
    observedTokens: number,
    trigger: "percent" | "tokens"
  ): Promise<void> {
    const recorder = getBoundTelemetryRecorder();
    const reasonStr =
      trigger === "tokens"
        ? `context_limit ${this.contextLimit} crossed (observed ${observedTokens} tokens, ${observedPercent.toFixed(1)}%)`
        : `threshold ${this.thresholdPercent}% crossed (observed ${observedPercent.toFixed(1)}%, ${observedTokens} tokens)`;
    const eventId = recorder?.recordExternalCompactStart("nudge_threshold", {
      reason: reasonStr,
      instructionsSource: this.instructions ? "static" : "none",
    });

    try {
      console.log(`[compact] nudge firing — ${reasonStr}`);
      const result = await this.session.compact(this.instructions);

      let tokensAfter: number | null = null;
      try {
        const post = this.safeGetContextUsage();
        tokensAfter = post?.tokens ?? null;
      } catch {
        // best-effort
      }

      if (recorder && typeof eventId === "number") {
        recorder.recordExternalCompactEnd(eventId, {
          tokensBefore: result.tokensBefore ?? null,
          tokensAfter,
        });
      }

      console.log(
        `[compact] nudge done — ${result.tokensBefore ?? "?"} → ${tokensAfter ?? "?"} tokens`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[compact] nudge failed: ${msg}`);

      if (recorder && typeof eventId === "number") {
        recorder.recordExternalCompactEnd(eventId, {
          aborted: true,
          error: msg,
        });
      }

      this.lastFailureAt = this.nowFn();
    } finally {
      this.inFlight = false;
    }
  }

  private safeGetContextUsage(): ContextUsage | undefined {
    try {
      const usage = (
        this.session as unknown as { getContextUsage?: () => unknown }
      ).getContextUsage?.();
      return usage as ContextUsage | undefined;
    } catch {
      return undefined;
    }
  }
}
