/**
 * Type definitions for the daydream loop.
 */

export interface DaydreamConfig {
  enabled?: boolean;
  /** How often the cycle fires, in minutes. Default 30. */
  interval_minutes?: number;
  /** Window of session activity to review, in minutes. Default 60. */
  lookback_minutes?: number;
  /** Skip cycle if fewer new turns since last run. Default 2. */
  min_turns_since_last?: number;
  /** Cap on memories stored per cycle. Default 5. */
  max_store_per_cycle?: number;
  /** Optional model override for ephemeral daydream sessions. */
  model?: {
    provider: string;
    model: string;
    thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  };
}

/**
 * In-memory state tracked by the runner across ticks. Not persisted
 * in Phase 5.0 — the first cycle after boot re-processes whatever's
 * in the lookback window, which is idempotent at the memory level.
 */
export interface WatermarkState {
  /** Unix ms of the last successful cycle start. Null before first run. */
  lastCycleAt: number | null;
}

/**
 * Outcome of a single cycle. Exposed to tests and to runner telemetry.
 */
export interface CycleResult {
  /** Unix ms when this cycle started. */
  startedAt: number;
  /** True if the cycle was skipped without running the LLM. */
  skipped: boolean;
  /** When skipped, the human-readable reason. */
  skipReason?: string;
  /** True if the cycle ran but errored partway. */
  errored: boolean;
  /** Error message when errored=true. */
  errorMessage?: string;
  /** Number of memories the LLM stored in this cycle. */
  stored: number;
  /** Wall-clock duration of the cycle in ms. */
  durationMs: number;
}
