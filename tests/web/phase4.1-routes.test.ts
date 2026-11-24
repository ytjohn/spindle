import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createWebServer, type ResolvedWebConfig } from "../../src/web/server";
import { MemoryEngine } from "../../src/memory/engine";
import type { FastifyInstance } from "fastify";

const AGENT = "eliza";
const TOKEN = "test-token";

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

describe("Phase 4.1 routes", () => {
  let dir: string;
  let engine: MemoryEngine;
  let app: FastifyInstance;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "spindle-p41-"));
    engine = await MemoryEngine.open(
      { enabled: true, database_path: join(dir, "memory.db") },
      {},
      dir
    );
    engine.registerAgent(AGENT);

    // Seed: two sessions, a few events, a few memories.
    engine.upsertSession({ agentId: AGENT, id: "s1", filePath: "/tmp/s1.jsonl" });
    engine.upsertSession({ agentId: AGENT, id: "s2", filePath: "/tmp/s2.jsonl" });
    engine.appendEvents({
      agentId: AGENT,
      sessionId: "s1",
      events: [
        mkEvent(0, "hello apple", "message", "user"),
        mkEvent(1, "reply about bananas", "message", "assistant"),
      ],
      newByteOffset: 200,
      newEventCount: 2,
      earliestTs: 1700000000000,
      latestTs: 1700000001000,
    });
    engine.appendEvents({
      agentId: AGENT,
      sessionId: "s2",
      events: [mkEvent(0, "another apple reference", "message", "user")],
      newByteOffset: 100,
      newEventCount: 1,
      earliestTs: 1700000010000,
      latestTs: 1700000010000,
    });
    await engine.store(AGENT, { content: "remembered fact one" });
    await engine.store(AGENT, { content: "remembered fact two about apples" });

    app = createWebServer(makeResolved(), {
      agentId: AGENT,
      agentName: "Eliza",
      sessionFile: undefined,
      memoryEnabled: true,
      daydreamEnabled: false,
      replEnabled: false,
      uiEnabled: false,
      version: "0.4.1-test",
      engine,
    });
  });

  afterEach(async () => {
    await app.close();
    engine.close();
    await rm(dir, { recursive: true, force: true });
  });

  // --- sessions -------------------------------------------------------------

  it("GET /spindle/sessions requires auth", async () => {
    const res = await app.inject({ method: "GET", url: "/spindle/sessions" });
    expect(res.statusCode).toBe(401);
  });

  it("GET /spindle/sessions returns both seeded sessions", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/spindle/sessions",
      ...auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(2);
    expect(body.has_more).toBe(false);
    const ids = body.items.map((s: { id: string }) => s.id).sort();
    expect(ids).toEqual(["s1", "s2"]);
  });

  it("GET /spindle/sessions/{id} returns one session", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/spindle/sessions/s1",
      ...auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe("s1");
    expect(res.json().event_count).toBe(2);
  });

  it("GET /spindle/sessions/{id} → 404 for unknown id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/spindle/sessions/nope",
      ...auth(),
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /spindle/sessions/{id}/events returns events in seq order", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/spindle/sessions/s1/events",
      ...auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items.map((e: { seq: number }) => e.seq)).toEqual([0, 1]);
  });

  // --- events ---------------------------------------------------------------

  it("GET /spindle/events?q= finds events across sessions", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/spindle/events?q=apple",
      ...auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(2);
    expect(body.items.every((e: { content_text: string }) =>
      e.content_text.includes("apple")
    )).toBe(true);
  });

  it("GET /spindle/events supports session_id + role filters", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/spindle/events?session_id=s1&role=assistant",
      ...auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.items[0].role).toBe("assistant");
  });

  // --- memories -------------------------------------------------------------

  it("GET /spindle/memories returns seeded memories", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/spindle/memories",
      ...auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(2);
  });

  it("GET /spindle/memories?q= narrows by FTS", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/spindle/memories?q=apples",
      ...auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.every((m: { content: string }) =>
      m.content.includes("apples")
    )).toBe(true);
  });

  it("GET /spindle/memories?kind=semantic filters by kind", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/spindle/memories?kind=semantic",
      ...auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(
      res.json().items.every((m: { kind: string }) => m.kind === "semantic")
    ).toBe(true);
  });

  it("GET /spindle/memories/{id} returns the row + neighbors array", async () => {
    const listRes = await app.inject({
      method: "GET",
      url: "/spindle/memories",
      ...auth(),
    });
    const id = listRes.json().items[0].id as number;
    const res = await app.inject({
      method: "GET",
      url: `/spindle/memories/${id}`,
      ...auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(id);
    expect(Array.isArray(body.neighbors)).toBe(true);
  });

  it("GET /spindle/memories/bogus → 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/spindle/memories/not-a-number",
      ...auth(),
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /spindle/memories/99999 → 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/spindle/memories/99999",
      ...auth(),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("web server without engine keeps 4.1 routes unregistered", () => {
  it("returns 404 from /spindle/sessions when engine is null", async () => {
    const app = createWebServer(
      {
        enabled: true,
        host: "127.0.0.1",
        port: 0,
        tokenEnv: "SPINDLE_WEB_TOKEN",
        token: TOKEN,
        uiEnabled: false,
      },
      {
        agentId: "eliza",
        agentName: "Eliza",
        sessionFile: undefined,
        memoryEnabled: false,
        daydreamEnabled: false,
        replEnabled: false,
      uiEnabled: false,
        version: "0.4.1-test",
        engine: null,
      }
    );
    try {
      const res = await app.inject({
        method: "GET",
        url: "/spindle/sessions",
        ...auth(),
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

function mkEvent(
  seq: number,
  text: string,
  eventType: string,
  role: string
) {
  return {
    seq,
    byte_offset: seq * 100,
    ts: 1700000000000 + seq * 1000,
    event_type: eventType,
    pi_event_id: `id-${seq}`,
    parent_id: null,
    role,
    model: null,
    content_json: JSON.stringify({ text }),
    content_text: text,
  };
}
