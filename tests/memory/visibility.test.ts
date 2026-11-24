import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "bun:sqlite";
import {
  buildVisibilityClause,
  type ThreadContext,
} from "../../src/memory/visibility";
import { runMigrations, applyPragmas } from "../../src/memory/schema";

describe("buildVisibilityClause (pure)", () => {
  it("returns shared + private clauses when no thread context", () => {
    const { clause, params } = buildVisibilityClause("agent-a");
    expect(clause).toContain("visibility = 'shared'");
    expect(clause).toContain("(visibility = 'private' AND agent_id = $agentId)");
    expect(clause).not.toContain("thread_id");
    expect(params).toEqual({ $agentId: "agent-a" });
  });

  it("adds an exact-match thread clause when given a thread id", () => {
    const { clause, params } = buildVisibilityClause("agent-a", { id: "audit:nagios-2026-04-11" });
    expect(clause).toContain("thread_id = $threadId");
    expect(clause).not.toContain("LIKE");
    expect(params).toEqual({
      $agentId: "agent-a",
      $threadId: "audit:nagios-2026-04-11",
    });
  });

  it("adds a LIKE thread clause when given a pattern", () => {
    const { clause, params } = buildVisibilityClause("agent-a", { pattern: "audit:nagios:%" });
    expect(clause).toContain("thread_id LIKE $threadPattern");
    expect(clause).not.toContain("thread_id = $");
    expect(params).toEqual({
      $agentId: "agent-a",
      $threadPattern: "audit:nagios:%",
    });
  });

  it("throws when both id and pattern are provided", () => {
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: intentional bad-input test
      buildVisibilityClause("agent-a", { id: "x", pattern: "y%" } as any)
    ).toThrow(/mutually exclusive/);
  });
});

// ============================================================================
// End-to-end tests: run buildVisibilityClause results against real SQLite data
// to prove the clause produces the rows we intend.
// ============================================================================

interface SeedRow {
  agent_id: string;
  visibility: "private" | "shared" | "thread";
  thread_id: string | null;
  content: string;
}

function seedRows(db: Database, rows: SeedRow[]): void {
  const now = Date.now();
  // Ensure unique agents exist
  const agents = new Set(rows.map((r) => r.agent_id));
  for (const id of agents) {
    db.run(
      `INSERT OR IGNORE INTO agents (id, display_name, created_at, last_seen_at) VALUES (?, ?, ?, ?)`,
      [id, id, now, now]
    );
  }
  for (const row of rows) {
    db.run(
      `INSERT INTO memories (agent_id, visibility, thread_id, kind, content, created_at)
       VALUES (?, ?, ?, 'semantic', ?, ?)`,
      [row.agent_id, row.visibility, row.thread_id, row.content, now]
    );
  }
}

function queryVisible(
  db: Database,
  agentId: string,
  thread?: ThreadContext
): string[] {
  const { clause, params } = buildVisibilityClause(agentId, thread);
  const sql = `SELECT content FROM memories WHERE ${clause} ORDER BY id`;
  const rows = db.query<{ content: string }, never>(sql).all(params as never);
  return rows.map((r) => r.content);
}

describe("buildVisibilityClause (against SQLite)", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyPragmas(db);
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("agent sees own private memories", () => {
    seedRows(db, [
      { agent_id: "juno", visibility: "private", thread_id: null, content: "juno-note" },
    ]);
    expect(queryVisible(db, "juno")).toEqual(["juno-note"]);
  });

  it("agent does NOT see another agent's private memories", () => {
    seedRows(db, [
      { agent_id: "juno", visibility: "private", thread_id: null, content: "juno-secret" },
      { agent_id: "casey", visibility: "private", thread_id: null, content: "casey-secret" },
    ]);
    expect(queryVisible(db, "juno")).toEqual(["juno-secret"]);
    expect(queryVisible(db, "casey")).toEqual(["casey-secret"]);
  });

  it("all agents see shared memories", () => {
    seedRows(db, [
      { agent_id: "juno", visibility: "shared", thread_id: null, content: "common-fact" },
      { agent_id: "casey", visibility: "private", thread_id: null, content: "casey-secret" },
    ]);
    expect(queryVisible(db, "juno")).toEqual(["common-fact"]);
    expect(queryVisible(db, "casey")).toEqual(["common-fact", "casey-secret"]);
  });

  it("thread memories NOT visible without a thread context", () => {
    seedRows(db, [
      { agent_id: "juno", visibility: "thread", thread_id: "audit:a", content: "audit-note" },
      { agent_id: "juno", visibility: "private", thread_id: null, content: "juno-note" },
    ]);
    expect(queryVisible(db, "juno")).toEqual(["juno-note"]);
  });

  it("thread memories visible with exact-match thread id", () => {
    seedRows(db, [
      { agent_id: "juno", visibility: "thread", thread_id: "audit:a", content: "audit-a-note" },
      { agent_id: "juno", visibility: "thread", thread_id: "audit:b", content: "audit-b-note" },
    ]);
    expect(queryVisible(db, "juno", { id: "audit:a" })).toEqual(["audit-a-note"]);
  });

  it("thread memories visible across agents via shared thread id", () => {
    // one agent creates the thread, another reads from it by knowing the id
    seedRows(db, [
      { agent_id: "juno", visibility: "thread", thread_id: "project:alpha", content: "from-juno" },
      { agent_id: "casey", visibility: "thread", thread_id: "project:alpha", content: "from-casey" },
    ]);
    expect(queryVisible(db, "juno", { id: "project:alpha" })).toEqual([
      "from-juno",
      "from-casey",
    ]);
    expect(queryVisible(db, "casey", { id: "project:alpha" })).toEqual([
      "from-juno",
      "from-casey",
    ]);
  });

  it("thread pattern matches a prefix", () => {
    seedRows(db, [
      { agent_id: "juno", visibility: "thread", thread_id: "audit:nagios:2026-04-11", content: "n-apr-11" },
      { agent_id: "juno", visibility: "thread", thread_id: "audit:nagios:2026-04-12", content: "n-apr-12" },
      { agent_id: "juno", visibility: "thread", thread_id: "audit:nagios:2026-05-01", content: "n-may-01" },
      { agent_id: "juno", visibility: "thread", thread_id: "audit:backup:2026-04-11", content: "b-apr-11" },
    ]);
    expect(queryVisible(db, "juno", { pattern: "audit:nagios:2026-04%" })).toEqual([
      "n-apr-11",
      "n-apr-12",
    ]);
    expect(queryVisible(db, "juno", { pattern: "audit:nagios:%" })).toEqual([
      "n-apr-11",
      "n-apr-12",
      "n-may-01",
    ]);
    expect(queryVisible(db, "juno", { pattern: "audit:%" })).toEqual([
      "n-apr-11",
      "n-apr-12",
      "n-may-01",
      "b-apr-11",
    ]);
  });

  it("thread pattern still includes shared and private memories", () => {
    seedRows(db, [
      { agent_id: "juno", visibility: "private", thread_id: null, content: "juno-secret" },
      { agent_id: "juno", visibility: "shared", thread_id: null, content: "common" },
      { agent_id: "juno", visibility: "thread", thread_id: "audit:a", content: "audit-a" },
      { agent_id: "juno", visibility: "thread", thread_id: "audit:b", content: "audit-b" },
    ]);
    expect(queryVisible(db, "juno", { pattern: "audit:%" })).toEqual([
      "juno-secret",
      "common",
      "audit-a",
      "audit-b",
    ]);
  });

  it("agent B cannot see agent A's private memories even within a shared thread", () => {
    seedRows(db, [
      { agent_id: "juno", visibility: "private", thread_id: null, content: "juno-secret" },
      { agent_id: "juno", visibility: "thread", thread_id: "project:alpha", content: "juno-thread-note" },
    ]);
    // The second agent knows project:alpha but still can't see the first's private memories
    expect(queryVisible(db, "casey", { id: "project:alpha" })).toEqual([
      "juno-thread-note",
    ]);
  });
});
