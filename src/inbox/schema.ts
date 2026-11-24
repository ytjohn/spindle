import type { Migration } from "../memory/schema";

/**
 * Inbox subsystem schema (Phase 4.4a).
 *
 * Files are the source of truth under `mail_root/`; these tables are a
 * per-spindle derived projection. Everything in this file is additive
 * to the shared memory DB — `src/memory/schema.ts` appends these
 * statements to its migrations list as version 5.
 *
 * Notes on id model:
 *   - `inbox_messages` uses INTEGER PRIMARY KEY + TEXT `message_id UNIQUE`.
 *     The integer is needed as the FTS5 content_rowid; the TEXT is the
 *     stable `{date}-{slug}-{hex4}` file id every caller uses.
 *   - `outbox_messages` and `drafts` have no FTS, so they can use TEXT
 *     PRIMARY KEY directly.
 *   - `inbox_attachments.message_id` references `inbox_messages.message_id`
 *     (which is UNIQUE) — CASCADE drops attachments when the projection
 *     removes the message row.
 *
 * Partitioning: every row carries `owner_agent_id` so a single DB could
 * in principle hold multiple agents' inboxes. 4.4a only uses one per
 * spindle, but the column + indexes are in place for the 4.4b cross-
 * agent path to grow into if we ever co-locate spindles.
 */
export const INBOX_SCHEMA_MIGRATION_V5: Migration = {
  version: 5,
  statements: [
    `CREATE TABLE IF NOT EXISTS agent_routes (
      agent_id      TEXT PRIMARY KEY,
      mail_root     TEXT NOT NULL,
      display_name  TEXT NOT NULL,
      avatar_path   TEXT,
      capabilities  TEXT,
      last_seen_at  INTEGER,
      created_by    TEXT NOT NULL CHECK (created_by IN ('config','operator','auto','self')),
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS inbox_messages (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id        TEXT NOT NULL UNIQUE,
      owner_agent_id    TEXT NOT NULL,
      rel_path          TEXT NOT NULL UNIQUE,
      from_auth         TEXT NOT NULL,
      from_display      TEXT NOT NULL,
      to_agent          TEXT NOT NULL,
      subject           TEXT,
      priority          TEXT,
      kind              TEXT NOT NULL DEFAULT 'message',
      thread_id         TEXT,
      in_reply_to       TEXT,
      metadata_json     TEXT,
      body              TEXT NOT NULL,
      status            TEXT NOT NULL CHECK (status IN ('unread','read','tombstoned')),
      date_iso          TEXT NOT NULL,
      date_ms           INTEGER NOT NULL,
      file_mtime        INTEGER NOT NULL,
      file_sha256       TEXT NOT NULL,
      projected_at      INTEGER NOT NULL
    )`,

    `CREATE INDEX IF NOT EXISTS idx_inbox_status_date
       ON inbox_messages(owner_agent_id, status, date_ms DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_inbox_unread
       ON inbox_messages(owner_agent_id, date_ms DESC)
       WHERE status = 'unread'`,
    `CREATE INDEX IF NOT EXISTS idx_inbox_thread
       ON inbox_messages(owner_agent_id, thread_id)
       WHERE thread_id IS NOT NULL`,

    `CREATE TABLE IF NOT EXISTS inbox_attachments (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id    TEXT NOT NULL REFERENCES inbox_messages(message_id) ON DELETE CASCADE,
      filename      TEXT NOT NULL,
      rel_path      TEXT NOT NULL,
      content_type  TEXT,
      size_bytes    INTEGER NOT NULL,
      sha256        TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_inbox_attachments_message
       ON inbox_attachments(message_id)`,

    `CREATE TABLE IF NOT EXISTS outbox_messages (
      id                TEXT PRIMARY KEY,
      owner_agent_id    TEXT NOT NULL,
      rel_path          TEXT NOT NULL UNIQUE,
      to_agent          TEXT NOT NULL,
      to_mail_root      TEXT NOT NULL,
      from_display      TEXT NOT NULL,
      subject           TEXT,
      body              TEXT NOT NULL,
      kind              TEXT NOT NULL,
      thread_id         TEXT,
      sent_at_iso       TEXT NOT NULL,
      sent_at_ms        INTEGER NOT NULL,
      delivery_status   TEXT NOT NULL CHECK (delivery_status IN ('delivered','unrouted','failed')),
      delivery_error    TEXT,
      file_mtime        INTEGER NOT NULL,
      file_sha256       TEXT NOT NULL,
      projected_at      INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_outbox_sent_at
       ON outbox_messages(owner_agent_id, sent_at_ms DESC)`,

    `CREATE TABLE IF NOT EXISTS inbox_drafts (
      id              TEXT PRIMARY KEY,
      owner_agent_id  TEXT NOT NULL,
      rel_path        TEXT NOT NULL UNIQUE,
      to_agent        TEXT,
      from_display    TEXT,
      subject         TEXT,
      body            TEXT NOT NULL,
      priority        TEXT,
      kind            TEXT NOT NULL DEFAULT 'message',
      metadata_json   TEXT,
      author_auth     TEXT NOT NULL,
      status          TEXT NOT NULL CHECK (status IN ('draft','ready')),
      created_at_iso  TEXT NOT NULL,
      updated_at_iso  TEXT NOT NULL,
      created_at_ms   INTEGER NOT NULL,
      updated_at_ms   INTEGER NOT NULL,
      file_mtime      INTEGER NOT NULL,
      file_sha256     TEXT NOT NULL,
      projected_at    INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_drafts_updated
       ON inbox_drafts(owner_agent_id, updated_at_ms DESC)`,

    // FTS5 over inbox_messages. The virtual table's rowid is linked to
    // inbox_messages.id (the INTEGER PK) via content_rowid. Triggers
    // keep subject + body + from_display in sync on every write.
    `CREATE VIRTUAL TABLE IF NOT EXISTS inbox_messages_fts USING fts5(
      subject, body, from_display,
      content='inbox_messages',
      content_rowid='id'
    )`,

    `CREATE TRIGGER IF NOT EXISTS inbox_messages_fts_insert
      AFTER INSERT ON inbox_messages BEGIN
      INSERT INTO inbox_messages_fts(rowid, subject, body, from_display)
      VALUES (new.id, new.subject, new.body, new.from_display);
    END`,

    `CREATE TRIGGER IF NOT EXISTS inbox_messages_fts_delete
      AFTER DELETE ON inbox_messages BEGIN
      INSERT INTO inbox_messages_fts(inbox_messages_fts, rowid, subject, body, from_display)
      VALUES ('delete', old.id, old.subject, old.body, old.from_display);
    END`,

    `CREATE TRIGGER IF NOT EXISTS inbox_messages_fts_update
      AFTER UPDATE ON inbox_messages BEGIN
      INSERT INTO inbox_messages_fts(inbox_messages_fts, rowid, subject, body, from_display)
      VALUES ('delete', old.id, old.subject, old.body, old.from_display);
      INSERT INTO inbox_messages_fts(rowid, subject, body, from_display)
      VALUES (new.id, new.subject, new.body, new.from_display);
    END`,
  ],
};
