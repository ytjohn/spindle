import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "bun:sqlite";
import {
  runMigrations,
  getCurrentVersion,
  applyPragmas,
  MIGRATIONS,
} from "../../src/memory/schema";

describe("memory schema migration", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyPragmas(db);
  });

  afterEach(() => {
    db.close();
  });

  it("getCurrentVersion returns 0 on a brand-new DB", () => {
    expect(getCurrentVersion(db)).toBe(0);
  });

  it("runMigrations brings a fresh DB to the latest version", () => {
    const latest = MIGRATIONS[MIGRATIONS.length - 1].version;
    const finalVersion = runMigrations(db);
    expect(finalVersion).toBe(latest);
    expect(getCurrentVersion(db)).toBe(latest);
  });

  it("creates the agents table", () => {
    runMigrations(db);
    const row = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='agents'`
      )
      .get();
    expect(row?.name).toBe("agents");
  });

  it("creates the memories table with the expected columns", () => {
    runMigrations(db);
    const cols = db
      .query<{ name: string; type: string }, []>(
        `PRAGMA table_info(memories)`
      )
      .all();
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("agent_id");
    expect(colNames).toContain("visibility");
    expect(colNames).toContain("thread_id");
    expect(colNames).toContain("kind");
    expect(colNames).toContain("content");
    expect(colNames).toContain("metadata");
    expect(colNames).toContain("embedding");
    expect(colNames).toContain("created_at");
    expect(colNames).toContain("last_recalled_at");
    expect(colNames).toContain("recall_count");
  });

  it("creates the memories_fts virtual table", () => {
    runMigrations(db);
    const row = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'`
      )
      .get();
    expect(row?.name).toBe("memories_fts");
  });

  it("creates the links table", () => {
    runMigrations(db);
    const row = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='links'`
      )
      .get();
    expect(row?.name).toBe("links");
  });

  it("creates the memory_accesses table with expected columns (v2)", () => {
    runMigrations(db);
    const row = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_accesses'`
      )
      .get();
    expect(row?.name).toBe("memory_accesses");

    const cols = db
      .query<{ name: string; type: string }, []>(
        `PRAGMA table_info(memory_accesses)`
      )
      .all();
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("memory_id");
    expect(colNames).toContain("accessed_at");
  });

  it("creates memory_accesses indexes (v2)", () => {
    runMigrations(db);
    const indexes = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_memory_accesses_%'`
      )
      .all()
      .map((r) => r.name);
    expect(indexes).toContain("idx_memory_accesses_memory");
    expect(indexes).toContain("idx_memory_accesses_time");
  });

  it("memory_accesses cascades when its memory is deleted (v2)", () => {
    runMigrations(db);
    db.run(
      `INSERT INTO agents (id, display_name, created_at, last_seen_at) VALUES (?, ?, ?, ?)`,
      ["test-agent", "Test", Date.now(), Date.now()]
    );
    db.run(
      `INSERT INTO memories (agent_id, visibility, kind, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      ["test-agent", "private", "semantic", "will be deleted", Date.now()]
    );
    const memoryId = db
      .query<{ id: number }, []>(`SELECT id FROM memories ORDER BY id DESC LIMIT 1`)
      .get()?.id;
    expect(memoryId).toBeDefined();
    db.run(
      `INSERT INTO memory_accesses (memory_id, accessed_at) VALUES (?, ?)`,
      [memoryId!, Date.now()]
    );
    db.run(
      `INSERT INTO memory_accesses (memory_id, accessed_at) VALUES (?, ?)`,
      [memoryId!, Date.now() + 1]
    );
    const beforeDelete = db
      .query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM memory_accesses`)
      .get()?.c;
    expect(beforeDelete).toBe(2);

    db.run(`DELETE FROM memories WHERE id = ?`, [memoryId!]);

    const afterDelete = db
      .query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM memory_accesses`)
      .get()?.c;
    expect(afterDelete).toBe(0);
  });

  it("adds tombstone columns to memories (v3)", () => {
    runMigrations(db);
    const cols = db
      .query<{ name: string; type: string }, []>(
        `PRAGMA table_info(memories)`
      )
      .all();
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("tombstoned_at");
    expect(colNames).toContain("tombstone_reason");
  });

  it("creates idx_memories_active partial index (v3)", () => {
    runMigrations(db);
    const indexRow = db
      .query<{ name: string; sql: string | null }, []>(
        `SELECT name, sql FROM sqlite_master
         WHERE type='index' AND name='idx_memories_active'`
      )
      .get();
    expect(indexRow?.name).toBe("idx_memories_active");
    // Partial index must carry its WHERE clause in the stored SQL
    expect(indexRow?.sql).toMatch(/tombstoned_at IS NULL/i);
  });

  it("v3 migration lands when applied to an existing v2 DB", () => {
    // Apply v1 + v2 manually, then let runMigrations bring v3 in
    const v1 = MIGRATIONS.find((m) => m.version === 1);
    const v2 = MIGRATIONS.find((m) => m.version === 2);
    expect(v1).toBeDefined();
    expect(v2).toBeDefined();
    db.transaction(() => {
      for (const stmt of v1!.statements) db.run(stmt);
      for (const stmt of v2!.statements) db.run(stmt);
      db.run(
        `INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)`,
        [1, Date.now()]
      );
      db.run(
        `INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)`,
        [2, Date.now()]
      );
    })();
    expect(getCurrentVersion(db)).toBe(2);

    // Seed a memory before the v3 migration runs
    db.run(
      `INSERT INTO agents (id, display_name, created_at, last_seen_at) VALUES (?, ?, ?, ?)`,
      ["test-agent", "Test", Date.now(), Date.now()]
    );
    db.run(
      `INSERT INTO memories (agent_id, visibility, kind, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      ["test-agent", "private", "semantic", "existing v2 row", Date.now()]
    );

    const finalVersion = runMigrations(db);
    expect(finalVersion).toBeGreaterThanOrEqual(3);

    // Existing row is un-tombstoned after migration
    const row = db
      .query<{ tombstoned_at: number | null }, []>(
        `SELECT tombstoned_at FROM memories WHERE content = 'existing v2 row'`
      )
      .get();
    expect(row?.tombstoned_at).toBeNull();
  });

  it("v2 migration lands when applied to an existing v1 DB", () => {
    // Walk the MIGRATIONS array to find v1 only, apply it manually, then
    // let runMigrations bring the DB up to v2.
    const v1 = MIGRATIONS.find((m) => m.version === 1);
    expect(v1).toBeDefined();
    db.transaction(() => {
      for (const stmt of v1!.statements) db.run(stmt);
      db.run(
        `INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)`,
        [1, Date.now()]
      );
    })();
    expect(getCurrentVersion(db)).toBe(1);

    const pre = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_accesses'`
      )
      .get();
    expect(pre).toBeNull();

    const finalVersion = runMigrations(db);
    expect(finalVersion).toBe(MIGRATIONS[MIGRATIONS.length - 1].version);

    const post = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_accesses'`
      )
      .get();
    expect(post?.name).toBe("memory_accesses");
  });

  it("creates FTS sync triggers (insert, delete, update)", () => {
    runMigrations(db);
    const triggers = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name`
      )
      .all()
      .map((r) => r.name);
    expect(triggers).toContain("memories_fts_insert");
    expect(triggers).toContain("memories_fts_delete");
    expect(triggers).toContain("memories_fts_update");
  });

  it("creates the expected indexes", () => {
    runMigrations(db);
    const indexes = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'`
      )
      .all()
      .map((r) => r.name);
    expect(indexes).toContain("idx_memories_agent");
    expect(indexes).toContain("idx_memories_visibility");
    expect(indexes).toContain("idx_memories_thread");
    expect(indexes).toContain("idx_memories_recalled");
    expect(indexes).toContain("idx_links_src");
    expect(indexes).toContain("idx_links_dst");
  });

  it("is idempotent — running twice is a no-op", () => {
    const first = runMigrations(db);
    const second = runMigrations(db);
    expect(first).toBe(second);
    // The schema_version table should have exactly one row per migration
    const rows = db
      .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM schema_version`)
      .get();
    expect(rows?.count).toBe(MIGRATIONS.length);
  });

  it("enforces the visibility CHECK constraint", () => {
    runMigrations(db);
    db.run(
      `INSERT INTO agents (id, display_name, created_at, last_seen_at) VALUES (?, ?, ?, ?)`,
      ["test-agent", "Test", Date.now(), Date.now()]
    );
    // 'public' is not a valid visibility — should fail
    expect(() =>
      db.run(
        `INSERT INTO memories (agent_id, visibility, kind, content, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        ["test-agent", "public", "semantic", "hello", Date.now()]
      )
    ).toThrow();
  });

  it("enforces that thread visibility requires a thread_id", () => {
    runMigrations(db);
    db.run(
      `INSERT INTO agents (id, display_name, created_at, last_seen_at) VALUES (?, ?, ?, ?)`,
      ["test-agent", "Test", Date.now(), Date.now()]
    );
    expect(() =>
      db.run(
        `INSERT INTO memories (agent_id, visibility, thread_id, kind, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ["test-agent", "thread", null, "semantic", "hello", Date.now()]
      )
    ).toThrow();
  });

  it("FTS triggers keep memories_fts in sync on insert", () => {
    runMigrations(db);
    db.run(
      `INSERT INTO agents (id, display_name, created_at, last_seen_at) VALUES (?, ?, ?, ?)`,
      ["test-agent", "Test", Date.now(), Date.now()]
    );
    db.run(
      `INSERT INTO memories (agent_id, visibility, kind, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      ["test-agent", "private", "semantic", "the quick brown fox", Date.now()]
    );
    const match = db
      .query<{ id: number; content: string }, [string]>(
        `SELECT m.id, m.content FROM memories m JOIN memories_fts f ON m.id = f.rowid
         WHERE memories_fts MATCH ?`
      )
      .get("quick");
    expect(match?.content).toBe("the quick brown fox");
  });

  it("FTS triggers keep memories_fts in sync on update", () => {
    runMigrations(db);
    db.run(
      `INSERT INTO agents (id, display_name, created_at, last_seen_at) VALUES (?, ?, ?, ?)`,
      ["test-agent", "Test", Date.now(), Date.now()]
    );
    db.run(
      `INSERT INTO memories (agent_id, visibility, kind, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      ["test-agent", "private", "semantic", "original content", Date.now()]
    );
    db.run(`UPDATE memories SET content = ? WHERE id = 1`, ["updated phrase"]);
    const originalMatch = db
      .query<{ id: number }, [string]>(
        `SELECT rowid AS id FROM memories_fts WHERE memories_fts MATCH ?`
      )
      .get("original");
    expect(originalMatch).toBeNull();
    const updatedMatch = db
      .query<{ id: number }, [string]>(
        `SELECT rowid AS id FROM memories_fts WHERE memories_fts MATCH ?`
      )
      .get("updated");
    expect(updatedMatch?.id).toBe(1);
  });

  it("FTS triggers keep memories_fts in sync on delete", () => {
    runMigrations(db);
    db.run(
      `INSERT INTO agents (id, display_name, created_at, last_seen_at) VALUES (?, ?, ?, ?)`,
      ["test-agent", "Test", Date.now(), Date.now()]
    );
    db.run(
      `INSERT INTO memories (agent_id, visibility, kind, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      ["test-agent", "private", "semantic", "will be deleted soon", Date.now()]
    );
    db.run(`DELETE FROM memories WHERE id = 1`);
    const match = db
      .query<{ id: number }, [string]>(
        `SELECT rowid AS id FROM memories_fts WHERE memories_fts MATCH ?`
      )
      .get("deleted");
    expect(match).toBeNull();
  });

  it("enforces foreign key from memories.agent_id to agents.id", () => {
    runMigrations(db);
    // Inserting a memory for a non-existent agent should fail
    expect(() =>
      db.run(
        `INSERT INTO memories (agent_id, visibility, kind, content, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        ["ghost-agent", "private", "semantic", "hello", Date.now()]
      )
    ).toThrow();
  });

  it("applyPragmas enables foreign keys", () => {
    const row = db
      .query<{ foreign_keys: number }, []>(`PRAGMA foreign_keys`)
      .get();
    expect(row?.foreign_keys).toBe(1);
  });

  it("applyPragmas sets WAL journal mode", () => {
    // In-memory DBs report "memory" instead of "wal" — the PRAGMA still
    // runs without error. Use a file-backed DB to confirm WAL is active.
    const tmp = `/tmp/spindle-schema-test-${Date.now()}.db`;
    const fileDb = new Database(tmp);
    try {
      applyPragmas(fileDb);
      const row = fileDb
        .query<{ journal_mode: string }, []>(`PRAGMA journal_mode`)
        .get();
      expect(row?.journal_mode).toBe("wal");
    } finally {
      fileDb.close();
      // Clean up DB + WAL files
      try {
        require("fs").unlinkSync(tmp);
        require("fs").unlinkSync(`${tmp}-wal`);
        require("fs").unlinkSync(`${tmp}-shm`);
      } catch {
        /* ignore cleanup errors */
      }
    }
  });
});
