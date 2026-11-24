/**
 * AgentStateWriter — maintains `<agentDir>/.pi/agent-state.json`.
 *
 * Why this exists: an agent once spent hours emitting
 * `400 … 126977 input tokens vs 131072 limit` on every turn while systemd
 * reported `active (running)`, its websocket was connected, and it was
 * logged into its game server the whole time. Nothing anywhere exposed it.
 * It was alive and unable to think.
 *
 * The governing rule (see the design doc): in-band recovery fails exactly
 * when it is needed. So this writer is deliberately dumb — it records what
 * an external observer needs and makes no attempt to fix anything.
 *
 * Two clocks, and their DIVERGENCE is the detector:
 *   heartbeat_at    — the process timer. Proves scheduling, not thinking.
 *   last_turn_ok_at — end of a successful turn. Proves thinking.
 * A single-timestamp heartbeat would have reported that agent healthy for
 * four hours, because its process was fine. Both fresh = healthy. Both stale =
 * dead, caught by ordinary staleness. Heartbeat fresh + turn stale, with
 * attempts happening = that failure.
 *
 * Not specific to any channel: the only channel-shaped thing here is the
 * `channels` map, which is populated from whatever channels the agent has.
 */

import { renameSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { mkdirSync } from "fs";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Channel } from "../channels/types";
import type { AgentState, ChannelLiveness, ContextSample } from "./types";

export interface AgentStateWriterOptions {
  session: AgentSession;
  agentId: string;
  agentDir: string;
  /** Channels to poll for liveness. Optional; absent = no channels block. */
  channels?: Channel[];
  /** Write cadence. Default 30s. */
  intervalMs?: number;
  /** Declared in the file so readers need no out-of-band knowledge. */
  staleAfterS?: number;
  /** Much larger than staleAfterS — idle agents legitimately don't turn. */
  turnStaleAfterS?: number;
  /** How many context samples to retain for rate derivation. */
  historyLength?: number;
  filePath?: string;
  /**
   * Injectable clock. Production uses the real one; tests need it because
   * rate derivation is undefined over a zero-length interval, which is
   * exactly what two back-to-back writes produce.
   */
  nowFn?: () => Date;
}

const DEFAULTS = {
  intervalMs: 30_000,
  staleAfterS: 120,
  turnStaleAfterS: 3600,
  historyLength: 10,
};

/** Coarse classification so readers can branch without regexing prose. */
export function classifyTurnError(err: string): string {
  const e = err.toLowerCase();
  if (e.includes("context length") || e.includes("input tokens") || e.includes("context_length"))
    return "context_length_exceeded";
  if (e.includes("rate limit") || e.includes("429")) return "rate_limited";
  if (e.includes("timeout") || e.includes("timed out")) return "timeout";
  if (e.includes("401") || e.includes("unauthorized") || e.includes("api key")) return "auth";
  if (e.includes("econnrefused") || e.includes("fetch failed") || e.includes("network"))
    return "network";
  if (/\b5\d\d\b/.test(e)) return "upstream_5xx";
  // Permanent, config-level 400s. These never self-heal and never should be
  // waited out — they mean the agent will fail EVERY turn until a human
  // changes something. Two real examples, each of which cost a day:
  //
  //   - A Copilot seat stopped listing claude-sonnet-4.6, and an agent
  //     failed for 14h. An org policy change on a Copilot Business seat;
  //     the model list belongs to the organisation paying for it, so this
  //     can happen again without notice.
  //   - "thinking.type.enabled is not supported for this model" on the
  //     Claude 5 family, from pi sending the legacy budget form.
  //
  // Both landed in "unknown", alongside genuinely transient faults. An
  // observer cannot tell "retry in a minute" from "nothing will ever work"
  // if they share a class.
  if (e.includes("model_not_available") || e.includes("model_not_supported"))
    return "model_unavailable";
  if (e.includes("is not supported for this model") || e.includes("invalid_request_error"))
    return "bad_request";
  return "unknown";
}

export class AgentStateWriter {
  private readonly opts: Required<Omit<AgentStateWriterOptions, "channels">> & {
    channels: Channel[];
  };

  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly startedAt: string;

  private lastTurnAttemptAt: string | null = null;
  private lastTurnOkAt: string | null = null;
  private lastTextOkAt: string | null = null;
  private lastToolCallOkAt: string | null = null;
  private consecutiveTurnErrors = 0;
  private lastErrorAt: string | null = null;
  private lastErrorClass: string | null = null;

  private lastCompactionAt: string | null = null;
  private compactions = 0;
  private history: ContextSample[] = [];

  constructor(options: AgentStateWriterOptions) {
    this.opts = {
      session: options.session,
      agentId: options.agentId,
      agentDir: options.agentDir,
      channels: options.channels ?? [],
      intervalMs: options.intervalMs ?? DEFAULTS.intervalMs,
      staleAfterS: options.staleAfterS ?? DEFAULTS.staleAfterS,
      turnStaleAfterS: options.turnStaleAfterS ?? DEFAULTS.turnStaleAfterS,
      historyLength: options.historyLength ?? DEFAULTS.historyLength,
      filePath: options.filePath ?? join(options.agentDir, ".pi", "agent-state.json"),
      nowFn: options.nowFn ?? (() => new Date()),
    };
    this.startedAt = this.opts.nowFn().toISOString();
  }

  start(): void {
    if (this.timer) return;
    // Compaction is observed directly rather than pushed in by the caller:
    // pi emits these regardless of whether spindle's telemetry recorder or
    // compact nudger are configured, and on the agents that need this file
    // most they are both switched off.
    try {
      const onEvent = (event: { type?: string }): void => {
        if (event?.type === "compaction_end" || event?.type === "auto_compaction_end") {
          this.recordCompaction();
        }
      };
      this.unsubscribe = this.opts.session.subscribe(
        onEvent as unknown as Parameters<AgentSession["subscribe"]>[0],
      );
    } catch {
      /* subscription is best-effort; the file is still useful without it */
    }
    this.write();
    this.timer = setInterval(() => this.write(), this.opts.intervalMs);
    // Never hold the process open for a heartbeat.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  // --- signals fed in from the turn tracker -------------------------

  /** Called for every completed turn, successful or not. */
  recordTurn(turn: { text?: string; toolCalls?: string[]; error?: string }): void {
    const now = this.opts.nowFn().toISOString();
    this.lastTurnAttemptAt = now;
    if (turn.error) {
      this.consecutiveTurnErrors += 1;
      this.lastErrorAt = now;
      this.lastErrorClass = classifyTurnError(turn.error);
    } else {
      this.consecutiveTurnErrors = 0;
      this.lastTurnOkAt = now;
      if (turn.text && turn.text.trim()) this.lastTextOkAt = now;
      if (turn.toolCalls && turn.toolCalls.length > 0) this.lastToolCallOkAt = now;
    }
    // Write immediately rather than waiting for the tick: an error is the
    // whole reason an observer is watching, and a 30s delay on the first
    // one is 30s of a fleet-wide problem going unseen.
    this.write();
  }

  recordCompaction(): void {
    this.lastCompactionAt = this.opts.nowFn().toISOString();
    this.compactions += 1;
  }

  // --- assembly -----------------------------------------------------

  private readContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | null {
    try {
      return this.opts.session.getContextUsage() ?? null;
    } catch {
      return null;
    }
  }

  private readSessionBytes(): number | null {
    try {
      const raw = this.opts.session as unknown as { sessionFile?: string };
      const f = raw.sessionFile;
      return f ? statSync(f).size : null;
    } catch {
      return null;
    }
  }

  private readModel(): { model: string | null; provider: string | null; thinking: string | null } {
    try {
      const raw = this.opts.session as unknown as {
        model?: { id?: string; provider?: string };
        thinkingLevel?: string;
      };
      return {
        model: raw.model?.id ?? null,
        provider: raw.model?.provider ?? null,
        thinking: raw.thinkingLevel ?? null,
      };
    } catch {
      return { model: null, provider: null, thinking: null };
    }
  }

  private readChannels(): Record<string, ChannelLiveness> {
    const out: Record<string, ChannelLiveness> = {};
    for (const ch of this.opts.channels) {
      try {
        const withLiveness = ch as Channel & { getLiveness?: () => ChannelLiveness };
        if (typeof withLiveness.getLiveness === "function") {
          out[ch.name] = withLiveness.getLiveness();
        }
      } catch {
        out[ch.name] = { connected: false, detail: "getLiveness threw" };
      }
    }
    return out;
  }

  /** Least-significant-digit first: level, then slope, then projection. */
  private deriveRate(): { ratePerMin: number | null; projectedAt: string | null } {
    if (this.history.length < 2) return { ratePerMin: null, projectedAt: null };
    const first = this.history[0];
    const last = this.history[this.history.length - 1];
    const minutes = (Date.parse(last.at) - Date.parse(first.at)) / 60_000;
    if (!(minutes > 0)) return { ratePerMin: null, projectedAt: null };
    const rate = (last.input - first.input) / minutes;
    if (!(rate > 0)) return { ratePerMin: Math.round(rate), projectedAt: null };

    const usage = this.readContextUsage();
    const window = usage?.contextWindow ?? null;
    if (!window) return { ratePerMin: Math.round(rate), projectedAt: null };
    const remaining = window - last.input;
    if (remaining <= 0) return { ratePerMin: Math.round(rate), projectedAt: last.at };
    const projected = new Date(
      this.opts.nowFn().getTime() + (remaining / rate) * 60_000,
    ).toISOString();
    return { ratePerMin: Math.round(rate), projectedAt: projected };
  }

  private computeVerdict(state: Omit<AgentState, "verdict" | "verdict_reason">): {
    verdict: AgentState["verdict"];
    reason: string;
  } {
    const reasons: string[] = [];
    let verdict: AgentState["verdict"] = "healthy";

    if (state.consecutive_turn_errors >= 3) {
      verdict = "unhealthy";
      reasons.push(
        `${state.consecutive_turn_errors} consecutive turn errors (${state.last_error_class})`,
      );
    } else if (state.consecutive_turn_errors > 0) {
      verdict = "degraded";
      reasons.push(`${state.consecutive_turn_errors} turn error(s) (${state.last_error_class})`);
    }

    if (state.context_pct !== null && state.context_pct >= 90) {
      verdict = "unhealthy";
      reasons.push(`context ${state.context_pct.toFixed(1)}%`);
    } else if (state.context_pct !== null && state.context_pct >= 75) {
      if (verdict === "healthy") verdict = "degraded";
      reasons.push(`context ${state.context_pct.toFixed(1)}%`);
    }

    return { verdict, reason: reasons.join("; ") || "ok" };
  }

  write(): void {
    try {
      const usage = this.readContextUsage();
      const now = this.opts.nowFn().toISOString();

      if (usage?.tokens != null) {
        const last = this.history[this.history.length - 1];
        if (!last || last.input !== usage.tokens) {
          this.history.push({ at: now, input: usage.tokens });
          while (this.history.length > this.opts.historyLength) this.history.shift();
        }
      }

      const { ratePerMin, projectedAt } = this.deriveRate();
      const m = this.readModel();

      const base: Omit<AgentState, "verdict" | "verdict_reason"> = {
        agent_id: this.opts.agentId,
        schema: 1,
        heartbeat_at: now,
        stale_after_s: this.opts.staleAfterS,
        pid: process.pid,
        started_at: this.startedAt,
        model: m.model,
        model_provider: m.provider,
        thinking_level: m.thinking,
        last_turn_attempt_at: this.lastTurnAttemptAt,
        last_turn_ok_at: this.lastTurnOkAt,
        turn_stale_after_s: this.opts.turnStaleAfterS,
        consecutive_turn_errors: this.consecutiveTurnErrors,
        last_error_at: this.lastErrorAt,
        last_error_class: this.lastErrorClass,
        context_tokens: usage?.tokens ?? null,
        context_window: usage?.contextWindow ?? null,
        context_pct: usage?.percent ?? null,
        context_history: [...this.history],
        context_rate_per_min: ratePerMin,
        projected_limit_at: projectedAt,
        last_compaction_at: this.lastCompactionAt,
        compactions_this_session: this.compactions,
        session_bytes: this.readSessionBytes(),
        last_tool_call_ok_at: this.lastToolCallOkAt,
        last_text_ok_at: this.lastTextOkAt,
        channels: this.readChannels(),
      };

      const { verdict, reason } = this.computeVerdict(base);
      const state: AgentState = { ...base, verdict, verdict_reason: reason };

      // Atomic: a torn read must never look like corruption to a watchdog.
      const path = this.opts.filePath;
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
      renameSync(tmp, path);
    } catch (err) {
      // Never let observability take the agent down.
      console.error(
        `[agent-state] write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
