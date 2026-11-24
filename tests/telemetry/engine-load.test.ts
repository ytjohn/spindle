import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "bun:sqlite";
import { applyPragmas, runMigrations } from "../../src/memory/schema";
import {
  insertEngineLoad,
  engineLoadNear,
  countEngineLoad,
  insertContextStat,
} from "../../src/telemetry/store";

describe("engine_load", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applyPragmas(db);
    runMigrations(db);
  });
  afterEach(() => db.close());

  it("records a sample and reads it back", () => {
    const id = insertEngineLoad(db, {
      sampledAt: 1_700_000_000_000,
      endpoint: "gpu2",
      numRunning: 8,
      numWaiting: 3,
      kvCachePct: 41.5,
    });
    expect(id).toBeGreaterThan(0);
    expect(countEngineLoad(db)).toBe(1);
  });

  it("records a failed scrape as a row, not a gap", () => {
    // A gap means the SAMPLER was down; an error row means the ENGINE
    // was unreachable. Conflating them misattributes an outage.
    insertEngineLoad(db, {
      sampledAt: 1_700_000_000_000,
      endpoint: "gpu2",
      error: "HTTP 503",
    });
    const row = engineLoadNear(db, "gpu2", 1_700_000_000_000);
    expect(row?.error).toBe("HTTP 503");
    expect(row?.num_running).toBeNull();
  });

  it("finds the nearest sample and respects the window", () => {
    insertEngineLoad(db, { sampledAt: 1000, endpoint: "gpu2", numRunning: 1 });
    insertEngineLoad(db, { sampledAt: 11_000, endpoint: "gpu2", numRunning: 9 });
    // 10_500 is nearer the second sample.
    expect(engineLoadNear(db, "gpu2", 10_500)?.num_running).toBe(9);
    // Far outside the window -> null, meaning "not sampled", NOT "idle".
    expect(engineLoadNear(db, "gpu2", 500_000, 30_000)).toBeNull();
  });

  it("keeps endpoints separate so agents split across engines do not cross-contaminate", () => {
    insertEngineLoad(db, { sampledAt: 5000, endpoint: "gpu1", numRunning: 12 });
    insertEngineLoad(db, { sampledAt: 5000, endpoint: "gpu2", numRunning: 1 });
    expect(engineLoadNear(db, "gpu1", 5000)?.num_running).toBe(12);
    expect(engineLoadNear(db, "gpu2", 5000)?.num_running).toBe(1);
  });

  it("answers the actual question: context pressure vs engine contention", () => {
    // Two equally slow turns, distinguishable only by engine load.
    insertContextStat(db, {
      agentId: "casey", sessionId: "s", recordedAt: 10_000,
      msSincePrompt: 90_000, contextTokens: 110_000, contextWindow: 118_000,
      contextPercent: 93.2,
    });
    insertContextStat(db, {
      agentId: "casey", sessionId: "s", recordedAt: 20_000,
      msSincePrompt: 90_000, contextTokens: 30_000, contextWindow: 118_000,
      contextPercent: 25.4,
    });
    insertEngineLoad(db, { sampledAt: 10_000, endpoint: "gpu2", numRunning: 1 });
    insertEngineLoad(db, { sampledAt: 20_000, endpoint: "gpu2", numRunning: 12 });

    const first = engineLoadNear(db, "gpu2", 10_000);
    const second = engineLoadNear(db, "gpu2", 20_000);
    // Slow + high context + idle engine  -> the agent's own context.
    expect(first?.num_running).toBe(1);
    // Slow + low context + busy engine   -> engine contention.
    expect(second?.num_running).toBe(12);
  });
});
