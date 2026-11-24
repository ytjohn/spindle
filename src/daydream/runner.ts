/**
 * DaydreamRunner — schedules + runs daydream cycles in the background.
 *
 * Ownership model:
 *   - Single runner per spindle process (one memory-enabled agent)
 *   - setInterval fires `interval_minutes` apart, FIRST tick scheduled
 *     `interval_minutes` in the future (not immediately at start) so
 *     the main session has time to stabilize after boot
 *   - Single-cycle-in-flight guarantee: if a tick fires while the
 *     previous cycle is still running, the new tick is DROPPED (logged)
 *   - Graceful stop: `stop()` cancels the interval and awaits any
 *     in-flight cycle before resolving
 *
 * Watermark state lives on the instance. Successful cycles advance the
 * watermark to the cycle's startedAt. Errored or skipped cycles do NOT
 * advance the watermark — the next cycle reprocesses the same window,
 * which is idempotent at the memory layer (the LLM sees the same
 * existing-memories context and should skip duplicates).
 *
 * Clock-jump handling: if `now() < lastCycleAt` (system clock moved
 * backward, NTP sync, DST adjustment), log once and reset the
 * watermark to `now`. Prevents the next cycle from thinking lots of
 * time has passed when it hasn't.
 */

import type { MemoryEngine } from "../memory/engine";
import type {
  CycleOptions,
  EphemeralSessionFactory,
} from "./cycle";
import { runDaydreamCycle } from "./cycle";
import type { DaydreamConfig, CycleResult } from "./types";

const DEFAULT_INTERVAL_MINUTES = 30;
const MS_PER_MINUTE = 60_000;

export interface DaydreamRunnerOptions {
  engine: MemoryEngine;
  agentId: string;
  agentDisplayName?: string;
  sessionFile: string;
  config: DaydreamConfig;
  sessionFactory: EphemeralSessionFactory;
  /** Test injection — defaults to Date.now. */
  now?: () => number;
  /** Test injection — defaults to global setInterval. */
  setIntervalFn?: typeof setInterval;
  /** Test injection — defaults to global clearInterval. */
  clearIntervalFn?: typeof clearInterval;
  /**
   * Optional observer called after each cycle completes (including
   * skipped and errored). Useful for tests and future metrics.
   */
  onCycleComplete?: (result: CycleResult) => void;
}

export class DaydreamRunner {
  private readonly engine: MemoryEngine;
  private readonly agentId: string;
  private readonly agentDisplayName?: string;
  private readonly sessionFile: string;
  private readonly config: DaydreamConfig;
  private readonly sessionFactory: EphemeralSessionFactory;
  private readonly nowFn: () => number;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private readonly onCycleComplete?: (result: CycleResult) => void;
  private readonly intervalMs: number;

  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private watermark: number;
  private started = false;
  private stopped = false;
  private clockJumpWarned = false;

  constructor(options: DaydreamRunnerOptions) {
    this.engine = options.engine;
    this.agentId = options.agentId;
    this.agentDisplayName = options.agentDisplayName;
    this.sessionFile = options.sessionFile;
    this.config = options.config;
    this.sessionFactory = options.sessionFactory;
    this.nowFn = options.now ?? Date.now;
    this.setIntervalFn = options.setIntervalFn ?? setInterval;
    this.clearIntervalFn = options.clearIntervalFn ?? clearInterval;
    this.onCycleComplete = options.onCycleComplete;

    const intervalMinutes =
      options.config.interval_minutes ?? DEFAULT_INTERVAL_MINUTES;
    this.intervalMs = intervalMinutes * MS_PER_MINUTE;

    // Initial watermark is "now at construction" so the first cycle
    // only reviews session activity from startup onward.
    this.watermark = this.nowFn();
  }

  /** Is the runner currently accepting ticks? */
  get isRunning(): boolean {
    return this.started && !this.stopped;
  }

  /** Current watermark (ms). Exposed for tests. */
  get currentWatermark(): number {
    return this.watermark;
  }

  /**
   * Start scheduling cycles. The first cycle fires `interval_minutes`
   * from now — not immediately — so the main session has time to
   * process any boot-time activity before daydream reviews it.
   *
   * Idempotent: calling start() twice is a no-op.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.intervalHandle = this.setIntervalFn(() => {
      void this.onTick();
    }, this.intervalMs);
  }

  /**
   * Cancel the interval and await any in-flight cycle. Idempotent.
   * After stop() resolves, no more cycles will run.
   */
  async stop(): Promise<void> {
    if (!this.started || this.stopped) {
      // Ensure we still await any in-flight cycle on repeated stops
      if (this.inFlight) await this.inFlight.catch(() => {});
      return;
    }
    this.stopped = true;
    if (this.intervalHandle !== null) {
      this.clearIntervalFn(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.inFlight) {
      await this.inFlight.catch(() => {});
    }
  }

  /**
   * Manually fire a cycle right now (bypassing the interval). Useful
   * for tests and for future ad-hoc triggers. Same single-in-flight
   * rules apply: if a cycle is already running, returns the existing
   * Promise.
   */
  async tick(): Promise<CycleResult | null> {
    return this.runCycleIfIdle();
  }

  /**
   * The setInterval handler. Drops the tick if a previous cycle is
   * still running — we don't queue ticks because daydream is a
   * best-effort background task and skipping one tick is fine.
   */
  private async onTick(): Promise<void> {
    if (this.stopped) return;
    if (this.inFlight) {
      console.log("[daydream] previous cycle still running, skipping tick");
      return;
    }
    await this.runCycleIfIdle();
  }

  /**
   * Actually execute a cycle. Wraps in `inFlight` so concurrent
   * callers (setInterval + manual tick()) share the same promise.
   */
  private runCycleIfIdle(): Promise<CycleResult | null> {
    if (this.stopped) return Promise.resolve(null);
    if (this.inFlight) {
      // Another caller is already running. Return null since we
      // didn't START a new cycle; the in-flight one will complete
      // via its own path.
      return this.inFlight.then(() => null);
    }

    const promise = this.executeCycle();
    this.inFlight = promise.then(
      () => undefined,
      () => undefined
    );
    return promise.finally(() => {
      this.inFlight = null;
    });
  }

  private async executeCycle(): Promise<CycleResult | null> {
    // Clock-jump handling: if the system clock moved backward since
    // the last watermark, reset rather than produce negative-elapsed
    // confusion in the prompt.
    const rightNow = this.nowFn();
    if (rightNow < this.watermark) {
      if (!this.clockJumpWarned) {
        console.warn(
          `[daydream] system clock moved backward (${this.watermark} -> ${rightNow}); resetting watermark`
        );
        this.clockJumpWarned = true;
      }
      this.watermark = rightNow;
    }

    const cycleOptions: CycleOptions = {
      engine: this.engine,
      agentId: this.agentId,
      agentDisplayName: this.agentDisplayName,
      sessionFile: this.sessionFile,
      watermark: this.watermark,
      config: this.config,
      sessionFactory: this.sessionFactory,
      now: this.nowFn,
    };

    let result: CycleResult;
    try {
      result = await runDaydreamCycle(cycleOptions);
    } catch (err) {
      // runDaydreamCycle is meant to return result objects for
      // expected failures, but catch unexpected throws so the runner
      // stays alive for the next interval.
      console.error("[daydream] unexpected cycle error:", err);
      result = {
        startedAt: rightNow,
        skipped: false,
        errored: true,
        errorMessage: err instanceof Error ? err.message : String(err),
        stored: 0,
        durationMs: this.nowFn() - rightNow,
      };
    }

    // Advance watermark only on successful cycles. Skipped cycles keep
    // the old watermark so the next run reprocesses the same window
    // (idempotent: the LLM sees the same activity and existing
    // memories, should no-op on its own).
    if (!result.skipped && !result.errored) {
      this.watermark = result.startedAt;
    }

    if (this.onCycleComplete) {
      try {
        this.onCycleComplete(result);
      } catch (err) {
        console.warn("[daydream] onCycleComplete observer threw:", err);
      }
    }

    return result;
  }
}
