/**
 * Shape of `<agentDir>/.pi/agent-state.json`.
 *
 * This file exists to be read by something OUTSIDE the agent. The governing
 * rule is that in-band recovery fails exactly when it is needed — a wedged
 * agent cannot compact itself, cannot report its own death, and cannot be
 * nudged back to health. So every field here is written by a healthy agent
 * and read by an external observer while the agent is dying.
 */

export interface ChannelLiveness {
  /** Transport is up (socket open / poller running). */
  connected: boolean;
  /** Authenticated where the channel has a concept of it. */
  logged_in?: boolean;
  /** Last inbound traffic on this channel, ISO-8601 Z. */
  last_activity_at?: string | null;
  /** Free-form per-channel detail; never parsed by readers. */
  detail?: string;
}

export interface ContextSample {
  at: string;
  input: number;
}

export interface AgentState {
  agent_id: string;
  schema: 1;

  /**
   * Written by the process timer. Proves the process is alive and
   * scheduling — NOT that the agent can think. See last_turn_ok_at.
   */
  heartbeat_at: string;
  /** Readers treat the file as `unknown` (== not healthy) past this age. */
  stale_after_s: number;

  pid: number;
  started_at: string;

  /**
   * Read live on every write, not captured at session start: pi lets an
   * agent swap model mid-session (a scheduled command can override it per
   * task via pi.setModel()), so a snapshot taken at boot would quietly go stale.
   * A model or thinking-level change is also one of the few things that
   * explains a sudden behaviour shift, which makes it worth having in any
   * view across agents.
   */
  model: string | null;
  model_provider: string | null;
  thinking_level: string | null;

  /**
   * The two-clock divergence is the detector. heartbeat_at fresh while
   * last_turn_ok_at is stale — with work being offered — is the wedged-agent
   * signature: alive, scheduled, and failing every attempt.
   */
  last_turn_attempt_at: string | null;
  last_turn_ok_at: string | null;
  turn_stale_after_s: number;
  consecutive_turn_errors: number;
  last_error_at: string | null;
  last_error_class: string | null;

  /**
   * API ground truth (`usage.input` of the most recent turn), never an
   * estimate from file size — the .jsonl grows monotonically while live
   * context sawtooths at every compaction, so the two diverge completely.
   */
  context_tokens: number | null;
  context_window: number | null;
  context_pct: number | null;
  /** Recent samples so readers derive RATE, not just level. */
  context_history: ContextSample[];
  context_rate_per_min: number | null;
  projected_limit_at: string | null;

  /**
   * NOTE: both are per-PROCESS, not per-session. With continue_session the
   * agent resumes a session across restarts but this writer is new, so a
   * compaction that happened before the restart is invisible here — an agent
   * that compacted 78,639 -> 14,868 twelve minutes before this writer started
   * reads last_compaction_at: null. The session .jsonl remains the record
   * of truth for compaction history; these fields describe this process's
   * observations only.
   */
  last_compaction_at: string | null;
  compactions_this_session: number;

  /**
   * Diagnostic only. MUST NOT be thresholded: one agent sat at 426KB holding
   * 14.7k tokens right after a compaction while another sat at 485KB holding
   * 77.6k and dying. File size cannot tell those apart.
   */
  session_bytes: number | null;

  /** Distinct signals: an agent locked in prose often still answers tools. */
  last_tool_call_ok_at: string | null;
  last_text_ok_at: string | null;

  channels: Record<string, ChannelLiveness>;

  /**
   * The agent's own opinion, and the least trustworthy field here — a
   * wedged agent's last verdict may say "healthy" and be stale. Readers
   * MUST compute their own from staleness first. Convenience only.
   */
  verdict: "healthy" | "degraded" | "unhealthy" | "unknown";
  verdict_reason: string;
}
