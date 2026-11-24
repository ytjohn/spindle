import type { Database } from "bun:sqlite";
import { INBOX_SCHEMA_MIGRATION_V5 } from "../inbox/schema";
import {
  TELEMETRY_SCHEMA_MIGRATION_V6,
  TELEMETRY_MODEL_MIGRATION_V7,
  ENGINE_LOAD_MIGRATION_V8,
  ENGINE_LOAD_TIMINGS_MIGRATION_V9,
  ENGINE_LOAD_WAITING_REASON_MIGRATION_V10,
} from "../telemetry/schema";

/**
 * Memory engine schema + migration runner.
 *
 * Migrations are an append-only array. Each migration is a set of SQL
 * statements applied in a single transaction. `schema_version` tracks
 * the highest applied version so re-opening a DB is idempotent.
 *
 * WAL mode docs: https://www.sqlite.org/wal.html
 * FTS5 docs: https://www.sqlite.org/fts5.html
 */

export interface Migration {
  version: number;
  /** SQL to run inside a transaction. May contain multiple statements. */
  statements: string[];
}

/**
 * Version 1 — initial schema.
 *
 * - `agents`: one row per agent that has ever written to this DB
 * - `memories`: primary table, one row per memory
 * - `memories_fts`: FTS5 virtual table mirroring `content`, kept in sync via triggers
 * - `links`: Hebbian co-activation links (schema only in 2.0; logic in 2.1)
 * - `schema_version`: applied-migration history
 *
 * `thread_id` is stored even though Phase 2.0 never sets it automatically — it's
 * kept in the schema so future features (extensions, daydream) can opt in
 * without a migration.
 */
const MIGRATION_V1: Migration = {
  version: 1,
  statements: [
    `CREATE TABLE IF NOT EXISTS agents (
      id             TEXT PRIMARY KEY,
      display_name   TEXT,
      created_at     INTEGER NOT NULL,
      last_seen_at   INTEGER NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS memories (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id          TEXT NOT NULL REFERENCES agents(id),
      visibility        TEXT NOT NULL CHECK (visibility IN ('private','shared','thread')),
      thread_id         TEXT,
      kind              TEXT NOT NULL CHECK (kind IN ('episodic','semantic','procedural')),
      content           TEXT NOT NULL,
      metadata          TEXT,
      embedding         BLOB,
      created_at        INTEGER NOT NULL,
      last_recalled_at  INTEGER,
      recall_count      INTEGER NOT NULL DEFAULT 0,
      CHECK (visibility != 'thread' OR thread_id IS NOT NULL)
    )`,

    `CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_visibility ON memories(visibility)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_thread ON memories(thread_id) WHERE thread_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_memories_recalled ON memories(last_recalled_at)`,

    // FTS5 external-content table mirrors memories.content. Triggers keep it in sync.
    `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      content='memories',
      content_rowid='id'
    )`,

    `CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END`,

    `CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END`,

    `CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END`,

    `CREATE TABLE IF NOT EXISTS links (
      src_id              INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      dst_id              INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      strength            REAL NOT NULL DEFAULT 0.1,
      created_at          INTEGER NOT NULL,
      last_reinforced_at  INTEGER NOT NULL,
      PRIMARY KEY (src_id, dst_id),
      CHECK (src_id != dst_id)
    )`,

    `CREATE INDEX IF NOT EXISTS idx_links_src ON links(src_id)`,
    `CREATE INDEX IF NOT EXISTS idx_links_dst ON links(dst_id)`,

    `CREATE TABLE IF NOT EXISTS schema_version (
      version     INTEGER PRIMARY KEY,
      applied_at  INTEGER NOT NULL
    )`,
  ],
};

/**
 * Version 2 — Hebbian + ACT-R plumbing (Phase 2.1).
 *
 * Adds `memory_accesses`: one row per `store` or `recall` of a given
 * memory. Used by ACT-R scoring mode to sum activation over the full
 * access history. Written in both linear and act-r modes so flipping
 * `scoring.mode` at runtime does not require a backfill.
 *
 * No primary key — multiple accesses within the same millisecond are
 * legitimate. `ON DELETE CASCADE` from `memories` means Phase 5.1 GC
 * drops memories and the log cleans itself up for free.
 */
const MIGRATION_V2: Migration = {
  version: 2,
  statements: [
    `CREATE TABLE IF NOT EXISTS memory_accesses (
      memory_id    INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      accessed_at  INTEGER NOT NULL
    )`,

    `CREATE INDEX IF NOT EXISTS idx_memory_accesses_memory ON memory_accesses(memory_id)`,
    `CREATE INDEX IF NOT EXISTS idx_memory_accesses_time ON memory_accesses(accessed_at)`,
  ],
};

/**
 * Version 3 — tombstone columns (Phase 5.1).
 *
 * Adds `tombstoned_at` / `tombstone_reason` to `memories`. Tombstoned
 * rows are excluded from every recall path by the visibility clause,
 * but remain on disk so a mistaken tombstone can be reversed with
 * `engine.restoreTombstoned(ids)`.
 *
 * The `idx_memories_active` partial index keeps the hot recall path
 * fast: most queries filter by `agent_id AND tombstoned_at IS NULL`,
 * and a partial index only stores rows matching that predicate.
 */
const MIGRATION_V3: Migration = {
  version: 3,
  statements: [
    `ALTER TABLE memories ADD COLUMN tombstoned_at INTEGER`,
    `ALTER TABLE memories ADD COLUMN tombstone_reason TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_memories_active
       ON memories(agent_id) WHERE tombstoned_at IS NULL`,
  ],
};

/**
 * Version 4 — session / event ingester tables (Phase 4.1).
 *
 * Projects pi's write-once JSONL session files into queryable SQL. The
 * JSONL remains the source of truth — every row preserves the raw line
 * in `events.content_json`, so if we later realize we want another
 * column projected out we can ALTER + backfill without a re-ingest.
 *
 * PK on `sessions` is compound `(agent_id, id)` because the memory DB
 * is shared across spindle instances via XDG paths; two agents
 * happening to generate the same basename stay distinct. Each spindle
 * only ever reads/writes its own agent's rows (scoped server-side).
 */
const MIGRATION_V4: Migration = {
  version: 4,
  statements: [
    `CREATE TABLE IF NOT EXISTS sessions (
      id                        TEXT NOT NULL,
      agent_id                  TEXT NOT NULL REFERENCES agents(id),
      file_path                 TEXT NOT NULL,
      started_at                INTEGER,
      last_activity_at          INTEGER,
      event_count               INTEGER NOT NULL DEFAULT 0,
      last_ingested_byte_offset INTEGER NOT NULL DEFAULT 0,
      last_ingest_error         TEXT,
      last_ingest_error_at      INTEGER,
      created_at                INTEGER NOT NULL,
      updated_at                INTEGER NOT NULL,
      PRIMARY KEY (agent_id, id)
    )`,

    `CREATE INDEX IF NOT EXISTS idx_sessions_agent_activity
       ON sessions(agent_id, last_activity_at DESC)`,

    `CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_file_path
       ON sessions(file_path)`,

    `CREATE TABLE IF NOT EXISTS events (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id       TEXT NOT NULL REFERENCES agents(id),
      session_id     TEXT NOT NULL,
      seq            INTEGER NOT NULL,
      byte_offset    INTEGER NOT NULL,
      ts             INTEGER,
      event_type     TEXT NOT NULL,
      pi_event_id    TEXT,
      parent_id      TEXT,
      role           TEXT,
      model          TEXT,
      content_json   TEXT NOT NULL,
      content_text   TEXT,
      UNIQUE(agent_id, session_id, seq),
      FOREIGN KEY (agent_id, session_id) REFERENCES sessions(agent_id, id)
    )`,

    `CREATE INDEX IF NOT EXISTS idx_events_session
       ON events(agent_id, session_id, seq)`,
    `CREATE INDEX IF NOT EXISTS idx_events_agent_ts
       ON events(agent_id, ts DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_events_type
       ON events(agent_id, event_type)`,

    `CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
      content_text,
      content='events',
      content_rowid='id'
    )`,

    `CREATE TRIGGER IF NOT EXISTS events_fts_insert AFTER INSERT ON events BEGIN
      INSERT INTO events_fts(rowid, content_text) VALUES (new.id, new.content_text);
    END`,

    `CREATE TRIGGER IF NOT EXISTS events_fts_delete AFTER DELETE ON events BEGIN
      INSERT INTO events_fts(events_fts, rowid, content_text) VALUES ('delete', old.id, old.content_text);
    END`,

    `CREATE TRIGGER IF NOT EXISTS events_fts_update AFTER UPDATE ON events BEGIN
      INSERT INTO events_fts(events_fts, rowid, content_text) VALUES ('delete', old.id, old.content_text);
      INSERT INTO events_fts(rowid, content_text) VALUES (new.id, new.content_text);
    END`,
  ],
};

export const MIGRATIONS: readonly Migration[] = [
  MIGRATION_V1,
  MIGRATION_V2,
  MIGRATION_V3,
  MIGRATION_V4,
  INBOX_SCHEMA_MIGRATION_V5,
  TELEMETRY_SCHEMA_MIGRATION_V6,
  TELEMETRY_MODEL_MIGRATION_V7,
  ENGINE_LOAD_MIGRATION_V8,
  ENGINE_LOAD_TIMINGS_MIGRATION_V9,
  ENGINE_LOAD_WAITING_REASON_MIGRATION_V10,
];

/**
 * Apply any pending migrations to `db`. Idempotent — safe to call on
 * every engine open. Returns the version the DB is at after running.
 *
 * The `schema_version` table is created as part of v1's statements, so
 * the current-version check has to handle the case where it doesn't
 * exist yet (first run on a brand-new DB).
 */
export function runMigrations(db: Database): number {
  const currentVersion = getCurrentVersion(db);

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;

    // Run all statements for this migration in one transaction so a mid-
    // migration failure doesn't leave the DB in a half-applied state.
    db.transaction(() => {
      for (const statement of migration.statements) {
        db.run(statement);
      }
      db.run(
        `INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)`,
        [migration.version, Date.now()]
      );
    })();
  }

  return getCurrentVersion(db);
}

/**
 * Read the highest applied schema version. Returns 0 if the
 * `schema_version` table doesn't exist yet (fresh DB).
 */
export function getCurrentVersion(db: Database): number {
  // Check table existence first to avoid an error on a brand-new DB.
  const tableRow = db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'`
    )
    .get();
  if (!tableRow) return 0;

  const row = db
    .query<{ v: number | null }, []>(
      `SELECT MAX(version) AS v FROM schema_version`
    )
    .get();
  return row?.v ?? 0;
}

/**
 * Apply the recommended PRAGMAs for a memory DB. Must be called after
 * opening the DB and before running migrations (WAL mode affects how
 * transactions behave).
 *
 * - journal_mode=WAL: concurrent readers + one writer, non-blocking
 * - synchronous=NORMAL: durable against app crashes, less fsync overhead
 * - busy_timeout=5000: wait up to 5s for a held write lock before ETIMEDOUT
 * - foreign_keys=ON: enforce the REFERENCES clauses
 * - temp_store=MEMORY: sort/group temps in RAM, not /tmp
 */
export function applyPragmas(db: Database): void {
  db.run(`PRAGMA journal_mode = WAL`);
  db.run(`PRAGMA synchronous = NORMAL`);
  db.run(`PRAGMA busy_timeout = 5000`);
  db.run(`PRAGMA foreign_keys = ON`);
  db.run(`PRAGMA temp_store = MEMORY`);
}
