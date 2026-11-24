/**
 * worker-dispatch — reactive (non-cron) ephemeral session dispatch.
 *
 * The scheduler fires ephemeral sessions on a cron tick (SchedulerRunner).
 * Some work is instead REACTIVE: it happens when a request arrives, not on
 * a clock. The first case is card replies: when the operator replies to a
 * card in a workspace channel, an ephemeral worker should answer it off the
 * main session's turn loop — on a chosen model, with a generous token budget —
 * so the main session stays free for live chat.
 *
 * This reuses the exact machinery the scheduler already trusts:
 *   createSchedulerSessionFactory  → an ephemeral pi session with a model
 *                                    override, tool allowlist, thinking level
 *   runUntilSettled                → drive one prompt to completion INCLUDING
 *                                    pi's own retries, then the caller disposes
 *
 * It differs from SchedulerRunner only in the trigger: a direct call instead
 * of a Cron job. No cron, no file watch, no idle gate — the caller decides
 * when to dispatch. A per-key in-flight guard prevents two workers colliding
 * on the same subject (e.g. two rapid replies to one card).
 */

import { createSchedulerSessionFactory } from "../scheduler/factory";
import { runUntilSettled } from "../scheduler/settle";
import type { ScheduleEntry } from "../scheduler/config";
import type { SharedSessionDeps } from "../agent/session";

export interface WorkerDispatchOptions {
  /**
   * The prompt sent to the ephemeral session as its first (and only) user
   * message. For a card reply this is the whole task: read the card, answer
   * in place with outbox_reply, resolve/dismiss if settled.
   */
  prompt: string;
  /**
   * Model override in provider/model form (e.g. "local/model"). When
   * omitted or unresolvable, the factory falls back to the agent's main
   * model — same rule as a scheduled entry's `model`.
   */
  model?: string;
  /**
   * Tool allowlist. When set, only these tools are enabled for the session.
   * Omit for the agent's full tool surface. Never pass [] (disables all).
   */
  tools?: string[];
  /** Thinking level. Default "off"; a card reply wants a real level. */
  thinkingLevel?: string;
  /** Max session duration in minutes. Default 10. -1 for no timeout. */
  timeoutMinutes?: number;
  /**
   * Suppress AGENTS.md / STATE.md for this session. Default false — a card
   * reply legitimately wants the agent's persona.
   */
  noContextFiles?: boolean;
  /**
   * In-flight guard key. A second dispatch with a live key is dropped
   * (returns { skipped: true }). Defaults to a random key (no guard).
   */
  key?: string;
  /** Label prefix for logs. Default "[worker]". */
  label?: string;
}

export interface WorkerDispatchResult {
  /** True when a prior dispatch with the same key was still running. */
  skipped: boolean;
  /** An agent_end / agent_settled was seen (false only on timeout/no-end). */
  settled: boolean;
  /** Error of the final assistant reply; undefined if a retry recovered. */
  error?: string;
  /** The assistant's final text. */
  text: string;
  /** pi automatic retries during the run. */
  retries: number;
  /** Wall-clock duration in ms. */
  durationMs: number;
}

export type WorkerDispatcher = (
  opts: WorkerDispatchOptions
) => Promise<WorkerDispatchResult>;

/**
 * Build a reactive dispatcher bound to the agent's shared session deps
 * (model runtime, settings, extension paths). Returns a function the runtime
 * exposes to extensions as runtime.dispatchWorker().
 */
export function createWorkerDispatcher(deps: SharedSessionDeps): WorkerDispatcher {
  const sessionFactory = createSchedulerSessionFactory(deps);
  const inFlight = new Set<string>();

  return async function dispatchWorker(
    opts: WorkerDispatchOptions
  ): Promise<WorkerDispatchResult> {
    const key = opts.key ?? `__nokey_${Math.random().toString(36).slice(2)}`;
    const label = opts.label ?? "[worker]";
    const startedAt = Date.now();

    if (opts.key && inFlight.has(key)) {
      console.log(`${label} in-flight for key "${key}" — dropping dispatch`);
      return { skipped: true, settled: false, text: "", retries: 0, durationMs: 0 };
    }
    inFlight.add(key);

    // Reuse ScheduleEntry as the factory's option shape. `command` is unused
    // by the factory (it only builds the session); runUntilSettled sends the
    // real prompt. `schedule` is likewise never read on a reactive path.
    const entry: ScheduleEntry = {
      command: `__worker:${key}`,
      schedule: "* * * * *",
      model: opts.model,
      tools: opts.tools && opts.tools.length > 0 ? opts.tools : undefined,
      thinking_level: opts.thinkingLevel ?? "off",
      no_context_files: opts.noContextFiles ?? false,
      timeout_minutes: opts.timeoutMinutes ?? 10,
    };

    const timeoutMs =
      entry.timeout_minutes === -1 ? Infinity : (entry.timeout_minutes ?? 10) * 60_000;

    let session;
    try {
      session = await sessionFactory(entry);
    } catch (err) {
      inFlight.delete(key);
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${label} failed to create session: ${msg}`);
      return {
        skipped: false,
        settled: false,
        error: msg,
        text: "",
        retries: 0,
        durationMs: Date.now() - startedAt,
      };
    }

    try {
      const outcome = await runUntilSettled(session, opts.prompt, timeoutMs);
      const durationMs = Date.now() - startedAt;
      if (outcome.retries > 0) {
        console.log(
          `${label} ${outcome.turnError ? "still failed" : "recovered"} after ${outcome.retries} retr${outcome.retries === 1 ? "y" : "ies"}`
        );
      }
      console.log(`${label} settled in ${durationMs}ms (key="${key}")`);
      return {
        skipped: false,
        settled: outcome.turnEnded,
        error: outcome.turnError,
        text: outcome.assistantText,
        retries: outcome.retries,
        durationMs,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${label} session error: ${msg}`);
      return {
        skipped: false,
        settled: false,
        error: msg,
        text: "",
        retries: 0,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      try {
        await session.close();
      } catch {
        // ignore — dispose failures are logged inside wrapEphemeral
      }
      inFlight.delete(key);
    }
  };
}
