import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { loadSpindleExtensions } from "../../src/extensions/loader";
import { createSpindleRuntime, resetWebBinding } from "../../src/extensions/runtime";

let testDir: string;
let app: FastifyInstance;

beforeEach(() => {
  testDir = resolve(tmpdir(), `spindle-loader-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  app = Fastify({ logger: false });
  resetWebBinding();
});

afterEach(async () => {
  await app.close();
  resetWebBinding();
  rmSync(testDir, { recursive: true, force: true });
});

function makeRuntime() {
  return createSpindleRuntime({
    agentId: "test",
    agentName: "Test",
    agentDir: testDir,
    memory: null,
    inbox: null,
    app,
    operatorToken: "tok",
  });
}

function writeExt(name: string, code: string) {
  const dir = resolve(testDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "index.ts"), code, "utf8");
  return `./${name}/index.ts`;
}

describe("loadSpindleExtensions", () => {
  it("returns a no-op teardown when defs is empty", async () => {
    const runtime = makeRuntime();
    const teardown = await loadSpindleExtensions(testDir, [], runtime);
    await expect(teardown()).resolves.toBeUndefined();
  });

  it("calls register() and the extension can register routes", async () => {
    const modPath = writeExt("hello-ext", `
      export async function register(runtime) {
        runtime.registerRoute({
          method: "GET",
          path: "/agent/test/hello",
          auth: "public",
          async handler(_req, reply) { return reply.send({ ok: true }); },
        });
      }
    `);
    const runtime = makeRuntime();
    await loadSpindleExtensions(testDir, [{ module: modPath }], runtime);

    await app.ready();
    const res = await app.inject({ method: "GET", url: "/agent/test/hello" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("calls teardowns in reverse load order", async () => {
    const order: number[] = [];
    const modA = writeExt("ext-a", `
      export async function register(_runtime) {
        return async () => { globalThis.__teardownOrder.push(1); };
      }
    `);
    const modB = writeExt("ext-b", `
      export async function register(_runtime) {
        return async () => { globalThis.__teardownOrder.push(2); };
      }
    `);

    (globalThis as unknown as Record<string, unknown>).__teardownOrder = order;

    const runtime = makeRuntime();
    const teardown = await loadSpindleExtensions(testDir, [
      { module: modA },
      { module: modB },
    ], runtime);

    expect(order).toEqual([]); // not called yet
    await teardown();
    expect(order).toEqual([2, 1]); // reverse order

    delete (globalThis as unknown as Record<string, unknown>).__teardownOrder;
  });

  it("throws on missing module file", async () => {
    const runtime = makeRuntime();
    await expect(
      loadSpindleExtensions(testDir, [{ module: "./nonexistent/index.ts" }], runtime)
    ).rejects.toThrow(/Failed to load extension/);
  });

  it("throws when register export is missing", async () => {
    const modPath = writeExt("no-register", `
      export const notRegister = () => {};
    `);
    const runtime = makeRuntime();
    await expect(
      loadSpindleExtensions(testDir, [{ module: modPath }], runtime)
    ).rejects.toThrow(/does not export a register/);
  });

  it("throws when register() throws", async () => {
    const modPath = writeExt("throws-ext", `
      export async function register(_runtime) {
        throw new Error("boom from register");
      }
    `);
    const runtime = makeRuntime();
    await expect(
      loadSpindleExtensions(testDir, [{ module: modPath }], runtime)
    ).rejects.toThrow(/boom from register/);
  });
});
