import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, appendFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { MemoryEngine } from "../../src/memory/engine";
import { SessionIngester } from "../../src/sessions/ingester";
import { createWebServer, type ResolvedWebConfig } from "../../src/web/server";
import type { FastifyInstance } from "fastify";

const AGENT = "eliza";
const TOKEN = "integration-token";

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
  return { headers: { authorization: `Bearer ${TOKEN}` } };
}

describe("ingest → API end-to-end", () => {
  let dir: string;
  let sessionDir: string;
  let engine: MemoryEngine;
  let ingester: SessionIngester;
  let app: FastifyInstance;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "spindle-e2e-"));
    sessionDir = join(dir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    engine = await MemoryEngine.open(
      { enabled: true, database_path: join(dir, "memory.db") },
      {},
      dir
    );
    engine.registerAgent(AGENT);
    ingester = new SessionIngester({
      agentId: AGENT,
      sessionDir,
      engine,
      pollIntervalMs: 50,
    });
    app = createWebServer(resolved(), {
      agentId: AGENT,
      agentName: "Eliza",
      sessionFile: undefined,
      memoryEnabled: true,
      daydreamEnabled: false,
      replEnabled: false,
      uiEnabled: false,
      version: "integration-test",
      engine,
    });
  });

  afterEach(async () => {
    await ingester.stop();
    await app.close();
    engine.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("write jsonl → backfill → /spindle/events?q= finds the line", async () => {
    const path = join(sessionDir, "live.jsonl");
    await writeFile(
      path,
      JSON.stringify({
        type: "session",
        id: "hdr",
        timestamp: "2026-04-16T12:00:00.000Z",
      }) +
        "\n" +
        JSON.stringify({
          type: "message",
          id: "u1",
          parentId: "hdr",
          timestamp: "2026-04-16T12:00:01.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "totally distinctive xyzzy token" }],
          },
        }) +
        "\n"
    );

    await ingester.backfill();

    const sessRes = await app.inject({
      method: "GET",
      url: "/spindle/sessions",
      ...auth(),
    });
    expect(sessRes.statusCode).toBe(200);
    expect(sessRes.json().total).toBe(1);
    expect(sessRes.json().items[0].id).toBe("live");

    const searchRes = await app.inject({
      method: "GET",
      url: "/spindle/events?q=xyzzy",
      ...auth(),
    });
    expect(searchRes.statusCode).toBe(200);
    expect(searchRes.json().total).toBe(1);
    expect(searchRes.json().items[0].content_text).toContain("xyzzy");
  });

  it("appended lines appear via poll loop", async () => {
    const path = join(sessionDir, "growing.jsonl");
    await writeFile(
      path,
      JSON.stringify({
        type: "session",
        id: "hdr",
        timestamp: "2026-04-16T12:00:00.000Z",
      }) + "\n"
    );

    await ingester.backfill();
    ingester.start();

    await appendFile(
      path,
      JSON.stringify({
        type: "message",
        id: "u1",
        timestamp: "2026-04-16T12:00:05.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "pineapple-express" }],
        },
      }) + "\n"
    );

    // Wait for a poll cycle.
    await new Promise((r) => setTimeout(r, 200));

    const res = await app.inject({
      method: "GET",
      url: "/spindle/events?q=pineapple",
      ...auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
  });
});
