import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createWebServer,
  resolveWebConfig,
  type ResolvedWebConfig,
} from "../../src/web/server";
import {
  createSpindleRuntime,
  resetWebBinding,
} from "../../src/extensions/runtime";
import type { FastifyInstance } from "fastify";

const baseDeps = {
  agentId: "eliza",
  agentName: "Eliza",
  sessionFile: "/tmp/eliza/sessions/x.jsonl",
  memoryEnabled: false,
  daydreamEnabled: false,
  replEnabled: true,
  uiEnabled: false,
  version: "0.4.0-test",
  engine: null,
};

function makeResolved(token = "test-token"): ResolvedWebConfig {
  return {
    enabled: true,
    host: "127.0.0.1",
    port: 0,
    tokenEnv: "SPINDLE_WEB_TOKEN",
    token,
    uiEnabled: false,
  };
}

describe("web routes", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    resetWebBinding();
    app = createWebServer(makeResolved(), baseDeps);
  });

  afterEach(async () => {
    await app.close();
    resetWebBinding();
  });

  it("GET /health returns 200 without auth", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      ok: true,
      agent_id: "eliza",
      version: "0.4.0-test",
    });
  });

  it("GET /spindle/info returns 401 without auth header", async () => {
    const res = await app.inject({ method: "GET", url: "/spindle/info" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "missing_authorization" });
  });

  it("GET /spindle/info returns 401 with wrong token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/spindle/info",
      headers: { authorization: "Bearer wrong" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "invalid_token" });
  });

  it("GET /spindle/info returns 200 with correct token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/spindle/info",
      headers: { authorization: "Bearer test-token" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      agent_id: "eliza",
      agent_name: "Eliza",
      session_file: "/tmp/eliza/sessions/x.jsonl",
      memory_enabled: false,
      daydream_enabled: false,
      repl_enabled: true,
      version: "0.4.0-test",
    });
    expect(Array.isArray(body.routes)).toBe(true);
    expect(body.routes).toContain("GET /health");
    expect(body.routes).toContain("GET /spindle/info");
    // No extensions registered — registered_agents should be empty array
    expect(body.registered_agents).toEqual([]);
  });

  it("GET /spindle/info includes registered_agents from SpindleRuntime", async () => {
    // Wire up a runtime against this test app and register a homepage.
    const runtime = createSpindleRuntime({
      agentId: "eliza",
      agentName: "Eliza",
      agentDir: "/tmp/eliza",
      memory: null,
      inbox: null,
      app,
      operatorToken: "test-token",
    });
    runtime.registerHomepage({ path: "/agent/eliza/", title: "Eliza Web", description: "demo" });

    const res = await app.inject({
      method: "GET",
      url: "/spindle/info",
      headers: { authorization: "Bearer test-token" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.registered_agents).toEqual([
      { path: "/agent/eliza/", title: "Eliza Web", description: "demo" },
    ]);
  });

  it("reserved /agent/{name}/* prefix returns 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/agent/eliza/anything",
    });
    expect(res.statusCode).toBe(404);
  });

  it("reserved /api/v1/spindle/* prefix returns 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/spindle/info",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("resolveWebConfig", () => {
  it("returns null when web block is missing", () => {
    expect(resolveWebConfig({ agent: { id: "x" } })).toBeNull();
  });

  it("returns null when enabled is false", () => {
    expect(
      resolveWebConfig({ agent: { id: "x" }, web: { enabled: false } })
    ).toBeNull();
  });

  it("throws when enabled but port missing", () => {
    expect(() =>
      resolveWebConfig(
        { agent: { id: "x" }, web: { enabled: true } },
        { SPINDLE_WEB_TOKEN: "t" }
      )
    ).toThrow(/port/);
  });

  it("throws when token env is unset", () => {
    expect(() =>
      resolveWebConfig(
        { agent: { id: "x" }, web: { enabled: true, port: 8787 } },
        {}
      )
    ).toThrow(/SPINDLE_WEB_TOKEN/);
  });

  it("honors custom token_env name", () => {
    expect(() =>
      resolveWebConfig(
        {
          agent: { id: "x" },
          web: { enabled: true, port: 8787, token_env: "CUSTOM_TOKEN" },
        },
        {}
      )
    ).toThrow(/CUSTOM_TOKEN/);
  });

  it("resolves cleanly when everything is present", () => {
    const resolved = resolveWebConfig(
      { agent: { id: "x" }, web: { enabled: true, port: 8787 } },
      { SPINDLE_WEB_TOKEN: "abc" }
    );
    expect(resolved).toMatchObject({
      enabled: true,
      host: "127.0.0.1",
      port: 8787,
      tokenEnv: "SPINDLE_WEB_TOKEN",
      token: "abc",
      uiEnabled: true,
    });
  });

  it("respects web.ui_enabled=false", () => {
    const resolved = resolveWebConfig(
      {
        agent: { id: "x" },
        web: { enabled: true, port: 8787, ui_enabled: false },
      },
      { SPINDLE_WEB_TOKEN: "abc" }
    );
    expect(resolved?.uiEnabled).toBe(false);
  });

  it("uses custom bind_host when provided", () => {
    const resolved = resolveWebConfig(
      {
        agent: { id: "x" },
        web: { enabled: true, port: 8787, bind_host: "0.0.0.0" },
      },
      { SPINDLE_WEB_TOKEN: "abc" }
    );
    expect(resolved?.host).toBe("0.0.0.0");
  });
});
