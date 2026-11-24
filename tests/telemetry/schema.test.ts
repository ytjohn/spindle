import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "bun:sqlite";
import {
  applyPragmas,
  runMigrations,
  MIGRATIONS,
} from "../../src/memory/schema";

describe("telemetry migration v6", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyPragmas(db);
  });

  afterEach(() => {
    db.close();
  });

  it("v6 is registered in MIGRATIONS", () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions).toContain(6);
  });

  it("runMigrations creates context_stats with expected columns", () => {
    runMigrations(db);
    const cols = db
      .query<{ name: string }, []>(`PRAGMA table_info(context_stats)`)
      .all()
      .map((r) => r.name);
    for (const expected of [
      "id",
      "agent_id",
      "session_id",
      "session_file",
      "turn_index",
      "recorded_at",
      "ms_since_prompt",
      "ms_since_first_token",
      "input_tokens",
      "output_tokens",
      "cache_read",
      "cache_write",
      "total_tokens",
      "context_tokens",
      "context_window",
      "context_percent",
      "tool_calls",
      "compacted_this_turn",
      "compact_trigger",
      "compact_tokens_before",
      "error",
    ]) {
      expect(cols).toContain(expected);
    }
  });

  it("runMigrations creates compact_events with expected columns", () => {
    runMigrations(db);
    const cols = db
      .query<{ name: string }, []>(`PRAGMA table_info(compact_events)`)
      .all()
      .map((r) => r.name);
    for (const expected of [
      "id",
      "agent_id",
      "session_id",
      "started_at",
      "ended_at",
      "trigger",
      "reason",
      "instructions_source",
      "tokens_before",
      "tokens_after",
      "aborted",
      "error",
    ]) {
      expect(cols).toContain(expected);
    }
  });

  it("creates the expected indexes", () => {
    runMigrations(db);
    const indexes = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'`
      )
      .all()
      .map((r) => r.name);
    expect(indexes).toContain("idx_context_stats_agent_time");
    expect(indexes).toContain("idx_context_stats_session");
    expect(indexes).toContain("idx_compact_events_agent_time");
    expect(indexes).toContain("idx_compact_events_session");
  });

  it("enforces compact_events.trigger CHECK constraint", () => {
    runMigrations(db);
    expect(() =>
      db.run(
        `INSERT INTO compact_events (agent_id, session_id, started_at, trigger)
         VALUES (?, ?, ?, ?)`,
        ["a", "s1", Date.now(), "not_a_real_trigger"]
      )
    ).toThrow();
    // Valid triggers should all succeed.
    for (const t of ["pi_auto", "nudge_threshold", "nudge_cadence", "user_manual"]) {
      expect(() =>
        db.run(
          `INSERT INTO compact_events (agent_id, session_id, started_at, trigger)
           VALUES (?, ?, ?, ?)`,
          ["a", "s1", Date.now(), t]
        )
      ).not.toThrow();
    }
  });

  it("enforces compact_events.instructions_source CHECK constraint", () => {
    runMigrations(db);
    // null is allowed by the CHECK (OR instructions_source IS NULL).
    expect(() =>
      db.run(
        `INSERT INTO compact_events (agent_id, session_id, started_at, trigger, instructions_source)
         VALUES (?, ?, ?, ?, ?)`,
        ["a", "s1", Date.now(), "pi_auto", null]
      )
    ).not.toThrow();
    for (const src of ["static", "memory", "none"]) {
      expect(() =>
        db.run(
          `INSERT INTO compact_events (agent_id, session_id, started_at, trigger, instructions_source)
           VALUES (?, ?, ?, ?, ?)`,
          ["a", "s1", Date.now(), "pi_auto", src]
        )
      ).not.toThrow();
    }
    expect(() =>
      db.run(
        `INSERT INTO compact_events (agent_id, session_id, started_at, trigger, instructions_source)
         VALUES (?, ?, ?, ?, ?)`,
        ["a", "s1", Date.now(), "pi_auto", "bogus"]
      )
    ).toThrow();
  });

  it("running migrations twice is idempotent", () => {
    const first = runMigrations(db);
    const second = runMigrations(db);
    expect(first).toBe(second);
  });
});
