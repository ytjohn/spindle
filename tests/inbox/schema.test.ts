import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { applyPragmas, runMigrations, getCurrentVersion, MIGRATIONS } from "../../src/memory/schema";

const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/**
 * v5 is the inbox schema migration. These tests pin:
 *   1. The migration runs cleanly on a fresh DB.
 *   2. It's idempotent — re-opening after full migration is a no-op.
 *   3. Every expected table/index/virtual-table/trigger was created.
 *   4. FTS sync triggers actually sync on INSERT/UPDATE/DELETE.
 *   5. CASCADE from inbox_messages → inbox_attachments works.
 */
describe("inbox schema v5", () => {
  let dir: string;
  let db: Database;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "spindle-inbox-schema-"));
    db = new Database(join(dir, "test.db"), { create: true });
    applyPragmas(db);
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("runs cleanly on a fresh DB and lands at the latest version", () => {
    const version = runMigrations(db);
    expect(version).toBe(LATEST_VERSION);
    expect(version).toBeGreaterThanOrEqual(5);
  });

  it("is idempotent on re-run", () => {
    runMigrations(db);
    const secondRun = runMigrations(db);
    expect(secondRun).toBe(LATEST_VERSION);
    expect(getCurrentVersion(db)).toBe(LATEST_VERSION);
  });

  it("creates every inbox table and index", () => {
    runMigrations(db);
    const tables = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
      )
      .all()
      .map((r) => r.name);
    expect(tables).toContain("agent_routes");
    expect(tables).toContain("inbox_messages");
    expect(tables).toContain("inbox_attachments");
    expect(tables).toContain("outbox_messages");
    expect(tables).toContain("inbox_drafts");

    const indexes = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='index'`
      )
      .all()
      .map((r) => r.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        "idx_inbox_status_date",
        "idx_inbox_unread",
        "idx_inbox_thread",
        "idx_inbox_attachments_message",
        "idx_outbox_sent_at",
        "idx_drafts_updated",
      ])
    );
  });

  it("creates the inbox_messages_fts virtual table and sync triggers", () => {
    runMigrations(db);
    const virtualTable = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='inbox_messages_fts'`
      )
      .get();
    expect(virtualTable?.name).toBe("inbox_messages_fts");

    const triggers = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'inbox_messages_fts%'`
      )
      .all()
      .map((r) => r.name);
    expect(triggers).toEqual(
      expect.arrayContaining([
        "inbox_messages_fts_insert",
        "inbox_messages_fts_delete",
        "inbox_messages_fts_update",
      ])
    );
  });

  it("FTS triggers keep subject + body + from_display in sync", () => {
    runMigrations(db);

    db.run(
      `INSERT INTO inbox_messages (
        message_id, owner_agent_id, rel_path, from_auth, from_display,
        to_agent, subject, kind, body, status, date_iso, date_ms,
        file_mtime, file_sha256, projected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "2026-04-17-jessica-firmware-a1b2",
        "casey",
        "inbox/2026-04-17-jessica-firmware-a1b2.md",
        "operator:example",
        "Jessica",
        "casey",
        "Firmware update",
        "message",
        "Hey, we need the firmware update by Friday",
        "unread",
        "2026-04-17T10:00:00Z",
        1745000000000,
        1745000000000,
        "sha-placeholder",
        1745000000000,
      ]
    );

    const hit = db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) as n FROM inbox_messages_fts WHERE inbox_messages_fts MATCH 'firmware'`
      )
      .get();
    expect(hit?.n).toBe(1);

    // Update subject + body — FTS should reflect the new values.
    db.run(
      `UPDATE inbox_messages SET subject = ?, body = ? WHERE message_id = ?`,
      ["Firmware rollback", "Never mind, rolling back", "2026-04-17-jessica-firmware-a1b2"]
    );
    const stale = db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) as n FROM inbox_messages_fts WHERE inbox_messages_fts MATCH 'friday'`
      )
      .get();
    expect(stale?.n).toBe(0);
    const fresh = db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) as n FROM inbox_messages_fts WHERE inbox_messages_fts MATCH 'rollback'`
      )
      .get();
    expect(fresh?.n).toBe(1);

    // Delete — FTS should drop the row.
    db.run(`DELETE FROM inbox_messages WHERE message_id = ?`, [
      "2026-04-17-jessica-firmware-a1b2",
    ]);
    const gone = db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) as n FROM inbox_messages_fts WHERE inbox_messages_fts MATCH 'rollback'`
      )
      .get();
    expect(gone?.n).toBe(0);
  });

  it("cascades attachment deletion when the parent message is removed", () => {
    runMigrations(db);

    db.run(
      `INSERT INTO inbox_messages (
        message_id, owner_agent_id, rel_path, from_auth, from_display,
        to_agent, subject, kind, body, status, date_iso, date_ms,
        file_mtime, file_sha256, projected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "2026-04-17-msg-with-attachment",
        "casey",
        "inbox/2026-04-17-msg-with-attachment/message.md",
        "operator:example",
        "Acme",
        "casey",
        "Order",
        "message",
        "See attached",
        "unread",
        "2026-04-17T11:00:00Z",
        1745000010000,
        1745000010000,
        "sha-parent",
        1745000010000,
      ]
    );

    db.run(
      `INSERT INTO inbox_attachments (
        message_id, filename, rel_path, content_type, size_bytes, sha256
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        "2026-04-17-msg-with-attachment",
        "order.pdf",
        "inbox/2026-04-17-msg-with-attachment/order.pdf",
        "application/pdf",
        1024,
        "sha-att",
      ]
    );

    const before = db
      .query<{ n: number }, []>(`SELECT COUNT(*) as n FROM inbox_attachments`)
      .get();
    expect(before?.n).toBe(1);

    db.run(`DELETE FROM inbox_messages WHERE message_id = ?`, [
      "2026-04-17-msg-with-attachment",
    ]);

    const after = db
      .query<{ n: number }, []>(`SELECT COUNT(*) as n FROM inbox_attachments`)
      .get();
    expect(after?.n).toBe(0);
  });

  it("enforces status and delivery_status CHECK constraints", () => {
    runMigrations(db);
    expect(() =>
      db.run(
        `INSERT INTO inbox_messages (
          message_id, owner_agent_id, rel_path, from_auth, from_display,
          to_agent, subject, kind, body, status, date_iso, date_ms,
          file_mtime, file_sha256, projected_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "bad-status",
          "casey",
          "inbox/bad-status.md",
          "op:x",
          "X",
          "casey",
          "S",
          "message",
          "body",
          "not-a-valid-status",
          "2026-04-17T00:00:00Z",
          1,
          1,
          "sha",
          1,
        ]
      )
    ).toThrow();
  });
});
