import type { Migration } from "../memory/schema";

/**
 * Context telemetry schema (Phase 5.2 — telemetry MVP).
 *
 * Two tables, append-only, scoped by `agent_id` so the shared memory
 * DB can hold stats from multiple spindles on one host. Same ownership
 * pattern as `sessions` / `events` in migration v4.
 *
 * Why two tables:
 *   - `context_stats` is one row per assistant turn (`agent_end`). It
 *     holds the per-turn latency + token + context% numbers needed to
 *     graph "how slow is the agent getting, and is it the context?"
 *   - `compact_events` is one row per compaction run (pi-auto,
 *     nudge-threshold, nudge-cadence, or user-manual). Separate table
 *     because compactions don't line up 1:1 with turns — some turns
 *     have zero, some have one bracketed by auto_compaction_{start,end}.
 *     `context_stats.compacted_this_turn` is a boolean hint for quick
 *     filtering; the `compact_events` row has the full detail.
 *
 * No FK from `context_stats.session_id` to `sessions.id` because the
 * session ingester may not have projected the row yet when a turn
 * ends — the ingester polls every N seconds and telemetry is synchronous
 * on the event subscription. A query that wants session metadata joins
 * on `(agent_id, session_id)` at read time.
 */
export const TELEMETRY_SCHEMA_MIGRATION_V6: Migration = {
  version: 6,
  statements: [
    `CREATE TABLE IF NOT EXISTS context_stats (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id              TEXT NOT NULL,
      session_id            TEXT NOT NULL,
      session_file          TEXT,
      turn_index            INTEGER,
      recorded_at           INTEGER NOT NULL,
      ms_since_prompt       INTEGER,
      ms_since_first_token  INTEGER,
      input_tokens          INTEGER,
      output_tokens         INTEGER,
      cache_read            INTEGER,
      cache_write           INTEGER,
      total_tokens          INTEGER,
      context_tokens        INTEGER,
      context_window        INTEGER,
      context_percent       REAL,
      tool_calls            INTEGER NOT NULL DEFAULT 0,
      compacted_this_turn   INTEGER NOT NULL DEFAULT 0,
      compact_trigger       TEXT,
      compact_tokens_before INTEGER,
      error                 TEXT
    )`,

    `CREATE INDEX IF NOT EXISTS idx_context_stats_agent_time
       ON context_stats(agent_id, recorded_at DESC)`,

    `CREATE INDEX IF NOT EXISTS idx_context_stats_session
       ON context_stats(agent_id, session_id, recorded_at DESC)`,

    `CREATE TABLE IF NOT EXISTS compact_events (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id            TEXT NOT NULL,
      session_id          TEXT NOT NULL,
      started_at          INTEGER NOT NULL,
      ended_at            INTEGER,
      trigger             TEXT NOT NULL CHECK (
        trigger IN ('pi_auto','nudge_threshold','nudge_cadence','user_manual')
      ),
      reason              TEXT,
      instructions_source TEXT CHECK (
        instructions_source IN ('static','memory','none') OR instructions_source IS NULL
      ),
      tokens_before       INTEGER,
      tokens_after        INTEGER,
      aborted             INTEGER NOT NULL DEFAULT 0,
      error               TEXT
    )`,

    `CREATE INDEX IF NOT EXISTS idx_compact_events_agent_time
       ON compact_events(agent_id, started_at DESC)`,

    `CREATE INDEX IF NOT EXISTS idx_compact_events_session
       ON compact_events(agent_id, session_id, started_at DESC)`,
  ],
};

/**
 * Adds model identity to `context_stats`.
 *
 * Every row until now recorded latency and tokens but not WHICH model
 * served the turn, which made two questions unanswerable:
 *
 *   - Cross-model comparison. A cutover from one model to another on
 *     the same host is only visible as a timestamp boundary you have to
 *     know about out-of-band. Worse, agents may be pointed at a served
 *     alias precisely so the backing model can be swapped without
 *     touching configs — so the served name does not change even when
 *     the model does.
 *   - Split-fleet routing. If some agents move to a second endpoint,
 *     rows from the two backends are indistinguishable without this.
 *
 * `model` is the pi model id and `model_provider` the provider key
 * (e.g. `local-vllm`), matching the pair already surfaced in
 * agent-state.json via src/state/writer.ts readModel(). Provider is the
 * part that actually identifies the endpoint; model id may be a stable
 * alias across backends.
 *
 * Both nullable: pre-existing rows keep NULL, and `session.model` is
 * legitimately undefined before a model is selected.
 *
 * ALTER TABLE ADD COLUMN is the whole migration — SQLite does this as a
 * metadata-only change, so it is cheap even on the ~1GB shared DB.
 */
export const TELEMETRY_MODEL_MIGRATION_V7: Migration = {
  version: 7,
  statements: [
    `ALTER TABLE context_stats ADD COLUMN model TEXT`,
    `ALTER TABLE context_stats ADD COLUMN model_provider TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_context_stats_model
       ON context_stats(agent_id, model, recorded_at DESC)`,
  ],
};

/**
 * Engine-load sampling.
 *
 * `context_stats` answers "how slow was this agent's turn". It cannot
 * answer WHY, because the two dominant causes look identical from
 * inside one agent: the agent's own context growing, versus the whole
 * fleet hitting one vLLM engine at the same moment. An agent going from
 * snappy to sluggish reads as context pressure whether or not that is
 * what happened.
 *
 * That distinction matters most on a slower host: on one, measured
 * aggregate throughput holds at ~13 tok/s to c=4 and collapses to
 * ~1.5 tok/s at c=8, so a burst does not degrade gently — the same
 * request that takes 11s alone can take minutes in a pile-up, with
 * nothing in the agent's own state to explain it.
 *
 * This table is sampled independently of any agent, on a wall-clock
 * cadence, so it captures load from every consumer — including
 * clients not running under spindle — and catches
 * bursts that begin and end inside a single long turn. A per-turn probe
 * from the recorder would miss both.
 *
 * Read it by joining on time:
 *   given a slow context_stats row, what was num_running at recorded_at?
 *   high context_percent + low num_running  -> the agent's own context
 *   normal context_percent + high num_running -> fleet contention
 *
 * `endpoint` distinguishes engines once inference is split across boxes
 * (each serving its own model), so rows from both can share the table.
 */
export const ENGINE_LOAD_MIGRATION_V8: Migration = {
  version: 8,
  statements: [
    `CREATE TABLE IF NOT EXISTS engine_load (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      sampled_at        INTEGER NOT NULL,
      endpoint          TEXT NOT NULL,
      num_running       INTEGER,
      num_waiting       INTEGER,
      kv_cache_pct      REAL,
      prefix_hit_rate   REAL,
      error             TEXT
    )`,

    // The join in the paragraph above is always (endpoint, time-ordered),
    // so lead with endpoint and keep sampled_at descending.
    `CREATE INDEX IF NOT EXISTS idx_engine_load_endpoint_time
       ON engine_load(endpoint, sampled_at DESC)`,

    // A bare time index serves "what was the whole fleet doing at T"
    // across every endpoint at once.
    `CREATE INDEX IF NOT EXISTS idx_engine_load_time
       ON engine_load(sampled_at DESC)`,
  ],
};

/**
 * Request-phase timing counters.
 *
 * Motivated by a real incident: one agent's replies arrived 30-50
 * minutes late, and the cause was queueing behind ten other agents
 * saturating the inference host. `num_running`/`num_waiting` show that an
 * engine is full, but they cannot say HOW LONG a request actually
 * waited — and "how long did it wait" is the question a user asks.
 *
 * vLLM decomposes request latency into queue / prefill / decode, which
 * separates the three causes that feel identical from outside:
 *   queue   high -> contention. The request sat before starting.
 *   prefill high -> the prompt is too big (context bloat).
 *   decode  high -> the model or kernel is slow.
 * That incident was pure queue; a separate kernel problem on another
 * host was pure decode. Without this split, both look like "it got slow".
 *
 * These are CUMULATIVE Prometheus counters, stored raw as sum+count
 * pairs. A single sample of a counter is a lifetime average, not a
 * current rate, so the interval mean must be derived by differencing
 * consecutive samples:
 *     (sum2 - sum1) / (count2 - count1)
 * Storing them raw and differencing at read time is deliberate --
 * computing a rate at write time would bake in the sampling interval
 * and lose the ability to re-window later. Reading one of these as an
 * instantaneous value is the same mistake that produced the "prefix
 * cache plateaued at 50%" misreport when it was climbing to 90%.
 */
export const ENGINE_LOAD_TIMINGS_MIGRATION_V9: Migration = {
  version: 9,
  statements: [
    `ALTER TABLE engine_load ADD COLUMN queue_time_sum REAL`,
    `ALTER TABLE engine_load ADD COLUMN queue_time_count INTEGER`,
    `ALTER TABLE engine_load ADD COLUMN prefill_time_sum REAL`,
    `ALTER TABLE engine_load ADD COLUMN prefill_time_count INTEGER`,
    `ALTER TABLE engine_load ADD COLUMN decode_time_sum REAL`,
    `ALTER TABLE engine_load ADD COLUMN decode_time_count INTEGER`,
  ],
};

/**
 * Adds `num_waiting_capacity`.
 *
 * vLLM splits waiting requests by reason. 'capacity' means the engine is
 * at max-num-seqs and genuinely full; 'deferred' means the scheduler held
 * a request back for its own reasons. That distinction is what separates
 * "the fleet saturated the engine" from "the scheduler is pacing itself",
 * which is the question this table exists to answer. Observed during
 * the pile-up described above: 10 waiting, all reason=capacity.
 *
 * WHY THIS IS A SEPARATE MIGRATION RATHER THAN PART OF V8: it was
 * originally added by editing v8's CREATE TABLE after v8 had already been
 * applied to the production DB. A migration runner records a version as
 * done and never revisits it, so the edit was invisible to every existing
 * database while silently present in new ones -- two divergent schemas
 * claiming the same version number. The sampler then crashed on deploy
 * with "table engine_load has no column named num_waiting_capacity".
 *
 * v8 has been reverted to what actually shipped, and the column is added
 * here so fresh and existing databases converge on the same shape.
 *
 * The rule this cost us: NEVER edit a migration that may already have
 * run. Once released, a migration is immutable; change it by adding
 * another one.
 */
export const ENGINE_LOAD_WAITING_REASON_MIGRATION_V10: Migration = {
  version: 10,
  statements: [
    `ALTER TABLE engine_load ADD COLUMN num_waiting_capacity INTEGER`,
  ],
};
