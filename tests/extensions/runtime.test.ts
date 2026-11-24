import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import {
  createSpindleRuntime,
  resetWebBinding,
  getBoundWebRuntime,
} from "../../src/extensions/runtime";

function makeApp(token = "test-token"): FastifyInstance {
  return Fastify({ logger: false });
}

describe("createSpindleRuntime", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = makeApp();
    resetWebBinding();
  });

  afterEach(async () => {
    await app.close();
    resetWebBinding();
  });

  it("sets the globalThis web binding", () => {
    expect(getBoundWebRuntime()).toBeNull();
    createSpindleRuntime({
      agentId: "eliza",
      agentName: "Eliza",
      agentDir: "/tmp/eliza",
      memory: null,
      inbox: null,
      app,
      operatorToken: "tok",
    });
    expect(getBoundWebRuntime()).not.toBeNull();
    expect(getBoundWebRuntime()!.agentId).toBe("eliza");
  });

  it("registers public route — no token needed", async () => {
    const runtime = createSpindleRuntime({
      agentId: "eliza",
      agentName: "Eliza",
      agentDir: "/tmp/eliza",
      memory: null,
      inbox: null,
      app,
      operatorToken: "secret",
    });

    runtime.registerRoute({
      method: "GET",
      path: "/agent/eliza/hello",
      auth: "public",
      async handler(_req, reply) {
        return reply.send({ hello: "world" });
      },
    });

    await app.ready();
    const res = await app.inject({ method: "GET", url: "/agent/eliza/hello" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ hello: "world" });
  });

  it("registers operator route — 401 without token, 200 with token", async () => {
    const runtime = createSpindleRuntime({
      agentId: "eliza",
      agentName: "Eliza",
      agentDir: "/tmp/eliza",
      memory: null,
      inbox: null,
      app,
      operatorToken: "secret",
    });

    runtime.registerRoute({
      method: "GET",
      path: "/agent/eliza/private",
      auth: "operator",
      async handler(_req, reply) {
        return reply.send({ secret: true });
      },
    });

    await app.ready();

    const unauthed = await app.inject({ method: "GET", url: "/agent/eliza/private" });
    expect(unauthed.statusCode).toBe(401);

    const wrongToken = await app.inject({
      method: "GET",
      url: "/agent/eliza/private",
      headers: { authorization: "Bearer wrong" },
    });
    expect(wrongToken.statusCode).toBe(401);

    const authed = await app.inject({
      method: "GET",
      url: "/agent/eliza/private",
      headers: { authorization: "Bearer secret" },
    });
    expect(authed.statusCode).toBe(200);
    expect(authed.json()).toEqual({ secret: true });
  });

  it("registerHomepage() is reflected in getRegisteredAgents()", () => {
    const runtime = createSpindleRuntime({
      agentId: "eliza",
      agentName: "Eliza",
      agentDir: "/tmp/eliza",
      memory: null,
      inbox: null,
      app,
      operatorToken: "tok",
    });

    expect(runtime.getRegisteredAgents()).toEqual([]);

    runtime.registerHomepage({ path: "/agent/eliza/", title: "Eliza", description: "test" });
    runtime.registerHomepage({ path: "/agent/eliza/feed", title: "Feed" });

    expect(runtime.getRegisteredAgents()).toEqual([
      { path: "/agent/eliza/", title: "Eliza", description: "test" },
      { path: "/agent/eliza/feed", title: "Feed" },
    ]);
  });

  it("createSession() throws 'not implemented'", async () => {
    const runtime = createSpindleRuntime({
      agentId: "eliza",
      agentName: "Eliza",
      agentDir: "/tmp/eliza",
      memory: null,
      inbox: null,
      app,
      operatorToken: "tok",
    });

    await expect(runtime.createSession()).rejects.toThrow("not implemented in Phase 4.3");
  });
});
