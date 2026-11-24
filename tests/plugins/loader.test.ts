import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlugins, publishApi, resolvePluginModule } from "../../src/plugins/loader";
import * as api from "../../src/api";

let root = "";
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "spindle-plugins-"));
  mkdirSync(join(root, "agent"));
  mkdirSync(join(root, "elsewhere"));
  // No import of spindle anywhere in these: the API is handed in.
  writeFileSync(
    join(root, "elsewhere", "fn-plugin.ts"),
    `export default (api: any) => ({
       name: "fn",
       channels: [{ key: "fn", create: () => ({ name: "fn:" + typeof api.sendUserMessageFrom, start: async () => {}, stop: async () => {} }) }],
     });`,
  );
  writeFileSync(join(root, "agent", "object-plugin.ts"), `export default { channels: [{ key: "obj", create: () => [] }] };`);
  writeFileSync(join(root, "agent", "no-default.ts"), `export const plugin = {};`);
  writeFileSync(join(root, "agent", "throws.ts"), `export default () => { throw new Error("bad setup"); };`);
  writeFileSync(join(root, "agent", "bad-channels.ts"), `export default { channels: "nope" };`);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("plugin loader", () => {
  it("resolves ./ and ../ against the agent directory and leaves the rest to the module resolver", () => {
    expect(resolvePluginModule("/a/agent", "./p.ts")).toBe("/a/agent/p.ts");
    expect(resolvePluginModule("/a/agent", "../other/p.ts")).toBe("/a/other/p.ts");
    expect(resolvePluginModule("/a/agent", "/abs/p.ts")).toBe("/abs/p.ts");
    expect(resolvePluginModule("/a/agent", "some-package/plugin")).toBe("some-package/plugin");
  });

  it("loads a plugin outside the repo that never imports spindle: the API is its argument", async () => {
    const agentDir = join(root, "agent");
    const plugins = await loadPlugins(
      agentDir,
      [{ module: "../elsewhere/fn-plugin.ts" }, { module: "./object-plugin.ts" }],
      api,
    );
    expect(plugins.map((p) => p.name)).toEqual(["fn", "./object-plugin.ts"]);
    expect(plugins.map((p) => p.channels!.map((c) => c.key))).toEqual([["fn"], ["obj"]]);
    const made = (await plugins[0].channels![0].create({}, {} as never)) as { name: string };
    expect(made.name).toBe("fn:function");
  });

  it("a plugin that cannot be loaded fails the boot, and says which one", async () => {
    const agentDir = join(root, "agent");
    await expect(loadPlugins(agentDir, [{ module: "./missing.ts" }], api)).rejects.toThrow(
      /Failed to load plugin "\.\/missing\.ts"/,
    );
    await expect(loadPlugins(agentDir, [{ module: "./no-default.ts" }], api)).rejects.toThrow(
      /no default export\. Found exports: plugin/,
    );
    await expect(loadPlugins(agentDir, [{ module: "./throws.ts" }], api)).rejects.toThrow(
      /threw while setting up: bad setup/,
    );
    await expect(loadPlugins(agentDir, [{ module: "./bad-channels.ts" }], api)).rejects.toThrow(
      /channels must be an array/,
    );
  });

  it("publishes the API where a pi extension with no import path can find it", () => {
    publishApi(api);
    const found = (globalThis as Record<symbol, unknown>)[Symbol.for("@spindle/api")] as typeof api;
    expect(found.deliver).toBe(api.deliver);
    expect(typeof found.getSessionKind).toBe("function");
  });
});
