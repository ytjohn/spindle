import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createWebServer, type ResolvedWebConfig } from "../../src/web/server";
import { MemoryEngine } from "../../src/memory/engine";
import type { FastifyInstance } from "fastify";

const AGENT = "eliza";
const TOKEN = "crud-token";

function resolved(): ResolvedWebConfig {
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
  return { authorization: `Bearer ${TOKEN}` };
}

describe("memory CRUD routes", () => {
  let dir: string;
  let engine: MemoryEngine;
  let app: FastifyInstance;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "spindle-crud-"));
    engine = await MemoryEngine.open(
      { enabled: true, database_path: join(dir, "memory.db") },
      {},
      dir
    );
    engine.registerAgent(AGENT);
    app = createWebServer(resolved(), {
      agentId: AGENT,
      agentName: "Eliza",
      sessionFile: undefined,
      memoryEnabled: true,
      daydreamEnabled: false,
      replEnabled: false,
      uiEnabled: false,
      version: "test",
      engine,
    });
  });

  afterEach(async () => {
    await app.close();
    engine.close();
    await rm(dir, { recursive: true, force: true });
  });

  // --- POST (create) --------------------------------------------------------

  it("POST /spindle/memories creates a row and returns 201", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/spindle/memories",
      headers: { ...auth(), "content-type": "application/json" },
      payload: JSON.stringify({ content: "new memory", kind: "episodic" }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.content).toBe("new memory");
    expect(body.kind).toBe("episodic");
    expect(body.visibility).toBe("private");
    expect(typeof body.id).toBe("number");
  });

  it("POST rejects missing content with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/spindle/memories",
      headers: { ...auth(), "content-type": "application/json" },
      payload: JSON.stringify({ kind: "semantic" }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST rejects invalid kind", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/spindle/memories",
      headers: { ...auth(), "content-type": "application/json" },
      payload: JSON.stringify({ content: "x", kind: "bogus" }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST rejects visibility=thread without thread_id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/spindle/memories",
      headers: { ...auth(), "content-type": "application/json" },
      payload: JSON.stringify({ content: "x", visibility: "thread" }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST requires auth", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/spindle/memories",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ content: "x" }),
    });
    expect(res.statusCode).toBe(401);
  });

  // --- PATCH (edit) ---------------------------------------------------------

  it("PATCH updates content and FTS picks up the new term", async () => {
    const id = await engine.store(AGENT, { content: "before" });
    const res = await app.inject({
      method: "PATCH",
      url: `/spindle/memories/${id}`,
      headers: { ...auth(), "content-type": "application/json" },
      payload: JSON.stringify({ content: "after xylophone" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().content).toBe("after xylophone");

    const hits = engine.listMemories(AGENT, { q: "xylophone" });
    expect(hits.total).toBe(1);
  });

  it("PATCH rejects empty body with 400", async () => {
    const id = await engine.store(AGENT, { content: "x" });
    const res = await app.inject({
      method: "PATCH",
      url: `/spindle/memories/${id}`,
      headers: { ...auth(), "content-type": "application/json" },
      payload: "{}",
    });
    expect(res.statusCode).toBe(400);
  });

  it("PATCH returns 404 for unknown id", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/spindle/memories/999999",
      headers: { ...auth(), "content-type": "application/json" },
      payload: JSON.stringify({ content: "nope" }),
    });
    expect(res.statusCode).toBe(404);
  });

  it("PATCH returns 404 for another agent's id", async () => {
    engine.registerAgent("other");
    const id = await engine.store("other", { content: "not yours" });
    const res = await app.inject({
      method: "PATCH",
      url: `/spindle/memories/${id}`,
      headers: { ...auth(), "content-type": "application/json" },
      payload: JSON.stringify({ content: "hacked" }),
    });
    expect(res.statusCode).toBe(404);
  });

  // --- DELETE (tombstone) ---------------------------------------------------

  it("DELETE tombstones and the row disappears from default list", async () => {
    const id = await engine.store(AGENT, { content: "goner" });
    const res = await app.inject({
      method: "DELETE",
      url: `/spindle/memories/${id}?reason=test`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tombstoned_at).not.toBeNull();
    expect(res.json().tombstone_reason).toBe("test");

    expect(engine.listMemories(AGENT).total).toBe(0);
    expect(
      engine.listMemories(AGENT, { includeTombstoned: true }).total
    ).toBe(1);
  });

  it("DELETE uses default reason when ?reason= omitted", async () => {
    const id = await engine.store(AGENT, { content: "x" });
    const res = await app.inject({
      method: "DELETE",
      url: `/spindle/memories/${id}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tombstone_reason).toBe("operator:web-ui");
  });

  it("DELETE twice returns 404 on the second call", async () => {
    const id = await engine.store(AGENT, { content: "x" });
    await app.inject({
      method: "DELETE",
      url: `/spindle/memories/${id}`,
      headers: auth(),
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/spindle/memories/${id}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
  });

  // --- POST /{id}/restore ---------------------------------------------------

  it("POST /{id}/restore un-tombstones a row", async () => {
    const id = await engine.store(AGENT, { content: "x" });
    engine.tombstoneScoped(AGENT, id, "r");
    const res = await app.inject({
      method: "POST",
      url: `/spindle/memories/${id}/restore`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tombstoned_at).toBeNull();
    expect(engine.listMemories(AGENT).total).toBe(1);
  });

  it("POST /{id}/restore returns 404 for an active row", async () => {
    const id = await engine.store(AGENT, { content: "x" });
    const res = await app.inject({
      method: "POST",
      url: `/spindle/memories/${id}/restore`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST /{id}/restore rejects non-numeric id with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/spindle/memories/not-a-number/restore",
      headers: auth(),
    });
    expect(res.statusCode).toBe(400);
  });
});
