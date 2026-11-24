import type { Database } from "bun:sqlite";

/**
 * Pure SQL writers + readers for `context_stats` and `compact_events`.
 * Takes a `Database` handle — shared with the memory engine. Nothing
 * here touches pi or spindle types, so this module is trivially
 * testable with a `:memory:` DB.
 */

export interface ContextStatRow {
  id: number;
  agent_id: string;
  session_id: string;
  session_file: string | null;
  turn_index: number | null;
  recorded_at: number;
  ms_since_prompt: number | null;
  ms_since_first_token: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read: number | null;
  cache_write: number | null;
  total_tokens: number | null;
  context_tokens: number | null;
  context_window: number | null;
  context_percent: number | null;
  tool_calls: number;
  compacted_this_turn: number;
  compact_trigger: string | null;
  compact_tokens_before: number | null;
  error: string | null;
  model: string | null;
  model_provider: string | null;
}

export interface ContextStatInsert {
  agentId: string;
  sessionId: string;
  sessionFile?: string | null;
  turnIndex?: number | null;
  recordedAt: number;
  msSincePrompt?: number | null;
  msSinceFirstToken?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
  totalTokens?: number | null;
  contextTokens?: number | null;
  contextWindow?: number | null;
  contextPercent?: number | null;
  toolCalls?: number;
  compactedThisTurn?: boolean;
  compactTrigger?: CompactTrigger | null;
  compactTokensBefore?: number | null;
  error?: string | null;
  /** pi model id serving this turn; null before a model is selected. */
  model?: string | null;
  /** pi provider key (e.g. `local-vllm`) — identifies the endpoint. */
  modelProvider?: string | null;
}

export type CompactTrigger =
  | "pi_auto"
  | "nudge_threshold"
  | "nudge_cadence"
  | "user_manual";

export type InstructionsSource = "static" | "memory" | "none";

export interface CompactEventRow {
  id: number;
  agent_id: string;
  session_id: string;
  started_at: number;
  ended_at: number | null;
  trigger: CompactTrigger;
  reason: string | null;
  instructions_source: InstructionsSource | null;
  tokens_before: number | null;
  tokens_after: number | null;
  aborted: number;
  error: string | null;
}

export interface CompactEventStartInsert {
  agentId: string;
  sessionId: string;
  startedAt: number;
  trigger: CompactTrigger;
  reason?: string | null;
  instructionsSource?: InstructionsSource | null;
}

export interface CompactEventEndUpdate {
  id: number;
  endedAt: number;
  tokensBefore?: number | null;
  tokensAfter?: number | null;
  aborted?: boolean;
  error?: string | null;
}

export function insertContextStat(
  db: Database,
  row: ContextStatInsert
): number {
  const stmt = db.prepare(
    `INSERT INTO context_stats (
      agent_id, session_id, session_file, turn_index, recorded_at,
      ms_since_prompt, ms_since_first_token,
      input_tokens, output_tokens, cache_read, cache_write, total_tokens,
      context_tokens, context_window, context_percent,
      tool_calls, compacted_this_turn, compact_trigger, compact_tokens_before,
      error, model, model_provider
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?
    )`
  );
  const res = stmt.run(
    row.agentId,
    row.sessionId,
    row.sessionFile ?? null,
    row.turnIndex ?? null,
    row.recordedAt,
    row.msSincePrompt ?? null,
    row.msSinceFirstToken ?? null,
    row.inputTokens ?? null,
    row.outputTokens ?? null,
    row.cacheRead ?? null,
    row.cacheWrite ?? null,
    row.totalTokens ?? null,
    row.contextTokens ?? null,
    row.contextWindow ?? null,
    row.contextPercent ?? null,
    row.toolCalls ?? 0,
    row.compactedThisTurn ? 1 : 0,
    row.compactTrigger ?? null,
    row.compactTokensBefore ?? null,
    row.error ?? null,
    row.model ?? null,
    row.modelProvider ?? null
  );
  return Number(res.lastInsertRowid);
}

export function listRecentContextStats(
  db: Database,
  agentId: string,
  limit: number,
  offset: number = 0
): ContextStatRow[] {
  return db
    .query<ContextStatRow, [string, number, number]>(
      `SELECT * FROM context_stats
        WHERE agent_id = ?
        ORDER BY recorded_at DESC, id DESC
        LIMIT ? OFFSET ?`
    )
    .all(agentId, limit, offset);
}

export function countContextStats(db: Database, agentId: string): number {
  const row = db
    .query<{ c: number }, [string]>(
      `SELECT COUNT(*) AS c FROM context_stats WHERE agent_id = ?`
    )
    .get(agentId);
  return row?.c ?? 0;
}

export function insertCompactEventStart(
  db: Database,
  row: CompactEventStartInsert
): number {
  const stmt = db.prepare(
    `INSERT INTO compact_events (
      agent_id, session_id, started_at, trigger, reason, instructions_source,
      aborted
    ) VALUES (?, ?, ?, ?, ?, ?, 0)`
  );
  const res = stmt.run(
    row.agentId,
    row.sessionId,
    row.startedAt,
    row.trigger,
    row.reason ?? null,
    row.instructionsSource ?? null
  );
  return Number(res.lastInsertRowid);
}

export function updateCompactEventEnd(
  db: Database,
  row: CompactEventEndUpdate
): void {
  db.prepare(
    `UPDATE compact_events
       SET ended_at = ?,
           tokens_before = COALESCE(?, tokens_before),
           tokens_after = COALESCE(?, tokens_after),
           aborted = ?,
           error = COALESCE(?, error)
     WHERE id = ?`
  ).run(
    row.endedAt,
    row.tokensBefore ?? null,
    row.tokensAfter ?? null,
    row.aborted ? 1 : 0,
    row.error ?? null,
    row.id
  );
}

export function listRecentCompactEvents(
  db: Database,
  agentId: string,
  limit: number,
  offset: number = 0
): CompactEventRow[] {
  return db
    .query<CompactEventRow, [string, number, number]>(
      `SELECT * FROM compact_events
        WHERE agent_id = ?
        ORDER BY started_at DESC, id DESC
        LIMIT ? OFFSET ?`
    )
    .all(agentId, limit, offset);
}

export function countCompactEvents(db: Database, agentId: string): number {
  const row = db
    .query<{ c: number }, [string]>(
      `SELECT COUNT(*) AS c FROM compact_events WHERE agent_id = ?`
    )
    .get(agentId);
  return row?.c ?? 0;
}

/**
 * One sample of a vLLM engine's instantaneous load.
 *
 * `error` is set when a scrape fails. A failed scrape is recorded as a
 * row rather than dropped, so a gap in the series means the SAMPLER was
 * down, while a run of rows with `error` means the ENGINE was
 * unreachable. Those are different incidents and reading a silent gap as
 * either one would be a guess.
 */
export interface EngineLoadInsert {
  sampledAt: number;
  endpoint: string;
  numRunning?: number | null;
  numWaiting?: number | null;
  numWaitingCapacity?: number | null;
  kvCachePct?: number | null;
  prefixHitRate?: number | null;
  /** Cumulative counters; difference consecutive samples for an interval mean. */
  queueTimeSum?: number | null;
  queueTimeCount?: number | null;
  prefillTimeSum?: number | null;
  prefillTimeCount?: number | null;
  decodeTimeSum?: number | null;
  decodeTimeCount?: number | null;
  error?: string | null;
}

export interface EngineLoadRow {
  id: number;
  sampled_at: number;
  endpoint: string;
  num_running: number | null;
  num_waiting: number | null;
  num_waiting_capacity: number | null;
  kv_cache_pct: number | null;
  prefix_hit_rate: number | null;
  queue_time_sum: number | null;
  queue_time_count: number | null;
  prefill_time_sum: number | null;
  prefill_time_count: number | null;
  decode_time_sum: number | null;
  decode_time_count: number | null;
  error: string | null;
}

export function insertEngineLoad(db: Database, row: EngineLoadInsert): number {
  const stmt = db.prepare(
    `INSERT INTO engine_load (
      sampled_at, endpoint, num_running, num_waiting, num_waiting_capacity,
      kv_cache_pct, prefix_hit_rate,
      queue_time_sum, queue_time_count,
      prefill_time_sum, prefill_time_count,
      decode_time_sum, decode_time_count,
      error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const res = stmt.run(
    row.sampledAt,
    row.endpoint,
    row.numRunning ?? null,
    row.numWaiting ?? null,
    row.numWaitingCapacity ?? null,
    row.kvCachePct ?? null,
    row.prefixHitRate ?? null,
    row.queueTimeSum ?? null,
    row.queueTimeCount ?? null,
    row.prefillTimeSum ?? null,
    row.prefillTimeCount ?? null,
    row.decodeTimeSum ?? null,
    row.decodeTimeCount ?? null,
    row.error ?? null
  );
  return Number(res.lastInsertRowid);
}

/**
 * Engine load closest in time to `atMs`, within +/- `windowMs`.
 *
 * This is the read side of the whole feature: given a slow turn from
 * `context_stats`, what was the engine doing at that moment? Nearest
 * sample rather than interpolation — at a ~10s cadence, interpolating
 * across a burst would invent numbers, and the question ("was load
 * elevated") does not need sub-sample precision.
 *
 * Returns null when nothing was sampled in the window, which is itself
 * informative: it means the sampler was not running then, so absence of
 * evidence must not be read as evidence of low load.
 */
export function engineLoadNear(
  db: Database,
  endpoint: string,
  atMs: number,
  windowMs = 30_000
): EngineLoadRow | null {
  const row = db
    .query<EngineLoadRow, [string, number, number, number]>(
      `SELECT * FROM engine_load
        WHERE endpoint = ? AND sampled_at BETWEEN ? AND ?
        ORDER BY ABS(sampled_at - ?) ASC
        LIMIT 1`
    )
    .get(endpoint, atMs - windowMs, atMs + windowMs, atMs);
  return row ?? null;
}

export function countEngineLoad(db: Database): number {
  const r = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM engine_load").get();
  return r?.n ?? 0;
}
