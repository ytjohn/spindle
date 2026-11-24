import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "bun:sqlite";
import { applyPragmas, runMigrations } from "../../src/memory/schema";
import {
  insertCompactEventStart,
  insertContextStat,
  listRecentCompactEvents,
  listRecentContextStats,
  countContextStats,
  countCompactEvents,
  updateCompactEventEnd,
} from "../../src/telemetry/store";

describe("telemetry store", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyPragmas(db);
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("inserts a context_stats row and reads it back", () => {
    const id = insertContextStat(db, {
      agentId: "casey",
      sessionId: "sess-1",
      sessionFile: "/tmp/sess-1.jsonl",
      turnIndex: 0,
      recordedAt: 1_700_000_000_000,
      msSincePrompt: 1234,
      msSinceFirstToken: 345,
      inputTokens: 12_000,
      outputTokens: 500,
      cacheRead: 10_000,
      cacheWrite: 2_000,
      totalTokens: 12_500,
      contextTokens: 38_000,
      contextWindow: 128_000,
      contextPercent: 29.6,
      toolCalls: 2,
      compactedThisTurn: false,
    });
    expect(id).toBeGreaterThan(0);
    const rows = listRecentContextStats(db, "casey", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].input_tokens).toBe(12_000);
    expect(rows[0].context_percent).toBeCloseTo(29.6, 1);
    expect(rows[0].tool_calls).toBe(2);
    expect(rows[0].compacted_this_turn).toBe(0);
  });

  it("records model identity and leaves it null when unknown", () => {
    insertContextStat(db, {
      agentId: "casey",
      sessionId: "sess-1",
      recordedAt: 1_700_000_000_000,
      model: "default-model",
      modelProvider: "local-vllm",
    });
    // A turn served before any model is selected: session.model is
    // undefined, so both fields must degrade to null rather than throw.
    insertContextStat(db, {
      agentId: "casey",
      sessionId: "sess-1",
      recordedAt: 1_700_000_001_000,
    });

    const rows = listRecentContextStats(db, "casey", 10);
    expect(rows).toHaveLength(2);
    // listRecentContextStats orders newest first.
    expect(rows[0].model).toBeNull();
    expect(rows[0].model_provider).toBeNull();
    expect(rows[1].model).toBe("default-model");
    expect(rows[1].model_provider).toBe("local-vllm");
  });

  it("distinguishes two endpoints serving the same served-model alias", () => {
    // The reason this column exists: every agent points at the same
    // served-model alias so the backing model can be swapped without
    // touching configs. Provider is what separates one host from another.
    insertContextStat(db, {
      agentId: "casey", sessionId: "s", recordedAt: 1,
      model: "default-model", modelProvider: "local-vllm",
      msSincePrompt: 40_000,
    });
    insertContextStat(db, {
      agentId: "casey", sessionId: "s", recordedAt: 2,
      model: "default-model", modelProvider: "other-vllm",
      msSincePrompt: 5_000,
    });
    const byProvider = db
      .query<{ model_provider: string; n: number; avg_ms: number }, []>(
        `SELECT model_provider, COUNT(*) AS n, AVG(ms_since_prompt) AS avg_ms
           FROM context_stats GROUP BY model_provider ORDER BY model_provider`
      )
      .all();
    expect(byProvider).toHaveLength(2);
    expect(byProvider[0].model_provider).toBe("local-vllm");
    expect(byProvider[0].avg_ms).toBe(40_000);
    expect(byProvider[1].model_provider).toBe("other-vllm");
    expect(byProvider[1].avg_ms).toBe(5_000);
  });

  it("lists rows in recorded_at DESC order with limit/offset", () => {
    for (let i = 0; i < 5; i++) {
      insertContextStat(db, {
        agentId: "a",
        sessionId: "s",
        recordedAt: 1_000 + i,
      });
    }
    const page1 = listRecentContextStats(db, "a", 2, 0);
    const page2 = listRecentContextStats(db, "a", 2, 2);
    expect(page1.map((r) => r.recorded_at)).toEqual([1_004, 1_003]);
    expect(page2.map((r) => r.recorded_at)).toEqual([1_002, 1_001]);
    expect(countContextStats(db, "a")).toBe(5);
  });

  it("scopes list/count by agent_id", () => {
    insertContextStat(db, { agentId: "a", sessionId: "s1", recordedAt: 1 });
    insertContextStat(db, { agentId: "b", sessionId: "s2", recordedAt: 2 });
    expect(countContextStats(db, "a")).toBe(1);
    expect(countContextStats(db, "b")).toBe(1);
    expect(countContextStats(db, "c")).toBe(0);
  });

  it("compact_events insert-start / update-end round-trip", () => {
    const id = insertCompactEventStart(db, {
      agentId: "casey",
      sessionId: "sess-1",
      startedAt: 1_000,
      trigger: "pi_auto",
      reason: "threshold",
      instructionsSource: "none",
    });
    expect(id).toBeGreaterThan(0);

    updateCompactEventEnd(db, {
      id,
      endedAt: 2_500,
      tokensBefore: 40_000,
      tokensAfter: 18_000,
      aborted: false,
    });
    const rows = listRecentCompactEvents(db, "casey", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger).toBe("pi_auto");
    expect(rows[0].reason).toBe("threshold");
    expect(rows[0].tokens_before).toBe(40_000);
    expect(rows[0].tokens_after).toBe(18_000);
    expect(rows[0].ended_at).toBe(2_500);
    expect(rows[0].aborted).toBe(0);
  });

  it("update-end preserves existing tokens_before when passed null", () => {
    const id = insertCompactEventStart(db, {
      agentId: "a",
      sessionId: "s",
      startedAt: 1,
      trigger: "nudge_threshold",
    });
    updateCompactEventEnd(db, {
      id,
      endedAt: 2,
      tokensBefore: 1000,
      tokensAfter: 500,
    });
    // Second update with nulls must NOT wipe the first update's values.
    updateCompactEventEnd(db, {
      id,
      endedAt: 3,
      aborted: true,
    });
    const rows = listRecentCompactEvents(db, "a", 10);
    expect(rows[0].tokens_before).toBe(1000);
    expect(rows[0].tokens_after).toBe(500);
    expect(rows[0].ended_at).toBe(3);
    expect(rows[0].aborted).toBe(1);
  });

  it("countCompactEvents scopes by agent", () => {
    insertCompactEventStart(db, {
      agentId: "a",
      sessionId: "s",
      startedAt: 1,
      trigger: "pi_auto",
    });
    insertCompactEventStart(db, {
      agentId: "a",
      sessionId: "s",
      startedAt: 2,
      trigger: "nudge_cadence",
    });
    insertCompactEventStart(db, {
      agentId: "b",
      sessionId: "s",
      startedAt: 3,
      trigger: "pi_auto",
    });
    expect(countCompactEvents(db, "a")).toBe(2);
    expect(countCompactEvents(db, "b")).toBe(1);
  });
});
