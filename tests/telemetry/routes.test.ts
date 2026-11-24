import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { FastifyInstance } from "fastify";
import {
  createWebServer,
  type ResolvedWebConfig,
} from "../../src/web/server";
import { MemoryEngine } from "../../src/memory/engine";
import {
  insertCompactEventStart,
  insertContextStat,
  updateCompactEventEnd,
} from "../../src/telemetry/store";

const AGENT = "casey";
const TOKEN = "t";

function makeResolved(): ResolvedWebConfig {
  return {
    enabled: true,
    host: "127.0.0.1",
    port: 0,
    tokenEnv: "SPINDLE_WEB_TOKEN",
    token: TOKEN,
    uiEnabled: false,
  };
}

function auth() {
  return { headers: { authorization: `Bearer ${TOKEN}` } };
}

describe("/spindle/context/* routes", () => {
  let dir: string;
  let engine: MemoryEngine;
  let app: FastifyInstance;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "spindle-telemetry-routes-"));
    engine = await MemoryEngine.open(
      { enabled: true, database_path: join(dir, "memory.db") },
      {},
      dir
    );
    engine.registerAgent(AGENT);

    // Seed some rows.
    const db = engine.getDb();
    insertContextStat(db, {
      agentId: AGENT,
      sessionId: "s1",
      recordedAt: 1_000,
      inputTokens: 1_000,
      contextTokens: 10_000,
      contextWindow: 128_000,
      contextPercent: 7.8,
    });
    insertContextStat(db, {
      agentId: AGENT,
      sessionId: "s1",
      recordedAt: 2_000,
      inputTokens: 2_000,
      contextTokens: 20_000,
      contextWindow: 128_000,
      contextPercent: 15.6,
    });
    const ceId = insertCompactEventStart(db, {
      agentId: AGENT,
      sessionId: "s1",
      startedAt: 1_500,
      trigger: "pi_auto",
    });
    updateCompactEventEnd(db, {
      id: ceId,
      endedAt: 1_800,
      tokensBefore: 22_000,
      tokensAfter: 9_000,
    });

    app = createWebServer(makeResolved(), {
      agentId: AGENT,
      agentName: "Casey",
      sessionFile: undefined,
      memoryEnabled: true,
      daydreamEnabled: false,
      replEnabled: false,
      uiEnabled: false,
      version: "test",
      engine,
      telemetryEnabled: true,
      getContextUsage: () => ({
        tokens: 21_000,
        contextWindow: 128_000,
        percent: 16.4,
      }),
      getCurrentSessionId: () => "s1",
    });
  });

  afterEach(async () => {
    await app.close();
    engine.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("requires auth", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/spindle/context/stats",
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET /spindle/context/stats returns rows newest-first", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/spindle/context/stats?limit=10",
      ...auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(2);
    expect(body.has_more).toBe(false);
    expect(body.items[0].recorded_at).toBe(2_000);
    expect(body.items[1].recorded_at).toBe(1_000);
  });

  it("GET /spindle/context/current returns live usage + latest row", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/spindle/context/current",
      ...auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.live).toEqual({
      tokens: 21_000,
      context_window: 128_000,
      percent: 16.4,
    });
    expect(body.session_id).toBe("s1");
    expect(body.latest.recorded_at).toBe(2_000);
  });

  it("GET /spindle/context/compact-events returns the compact row", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/spindle/context/compact-events",
      ...auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].trigger).toBe("pi_auto");
    expect(body.items[0].tokens_before).toBe(22_000);
    expect(body.items[0].tokens_after).toBe(9_000);
    expect(body.items[0].aborted).toBe(false);
  });

  it("routes stay unregistered when telemetryEnabled=false", async () => {
    const app2 = createWebServer(makeResolved(), {
      agentId: AGENT,
      agentName: "Casey",
      sessionFile: undefined,
      memoryEnabled: true,
      daydreamEnabled: false,
      replEnabled: false,
      uiEnabled: false,
      version: "test",
      engine,
      telemetryEnabled: false,
    });
    const res = await app2.inject({
      method: "GET",
      url: "/spindle/context/stats",
      ...auth(),
    });
    expect(res.statusCode).toBe(404);
    await app2.close();
  });

  it("falls back to latest row when live getter absent", async () => {
    const app2 = createWebServer(makeResolved(), {
      agentId: AGENT,
      agentName: "Casey",
      sessionFile: undefined,
      memoryEnabled: true,
      daydreamEnabled: false,
      replEnabled: false,
      uiEnabled: false,
      version: "test",
      engine,
      telemetryEnabled: true,
    });
    const res = await app2.inject({
      method: "GET",
      url: "/spindle/context/current",
      ...auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.live).toBeNull();
    expect(body.latest.recorded_at).toBe(2_000);
    expect(body.session_id).toBe("s1");
    await app2.close();
  });
});
