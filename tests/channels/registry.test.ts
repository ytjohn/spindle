import { describe, expect, it } from "vitest";
import {
  activePlugins,
  assertUniqueKeys,
  channelLogName,
  createChannels,
  unclaimedChannelKeys,
  type ChannelHost,
  type ChannelPlugin,
} from "../../src/channels/registry";
import { BUILTIN_CHANNEL_PLUGINS } from "../../src/channels/builtin";
import type { Channel } from "../../src/channels/types";
import type { AgentConfig } from "../../src/types";

const channel = (name: string): Channel => ({ name, start: async () => {}, stop: async () => {} });
const plugin = (key: string, extra: Partial<ChannelPlugin> = {}): ChannelPlugin => ({
  key,
  create: () => channel(key),
  ...extra,
});
const host = (channels: Record<string, unknown>): ChannelHost => ({
  agentDir: "/agent",
  config: { agent: { id: "a" }, channels } as unknown as AgentConfig,
  channels: () => [],
  sessionDeps: () => {
    throw new Error("no session yet");
  },
});

describe("channel plugins", () => {
  it("only the plugins whose key is configured are active", () => {
    const plugins = [plugin("a"), plugin("b"), plugin("c"), plugin("d"), plugin("e")];
    const config = host({ a: {}, b: false, c: [], d: [{ name: "x" }] }).config;
    expect(activePlugins(plugins, config).map((p) => p.key)).toEqual(["a", "d"]);
    expect(activePlugins(plugins, { agent: { id: "a" } } as AgentConfig)).toEqual([]);
  });

  it("start order is the plugin's order, then registration; unordered plugins come after the built-ins", () => {
    const plugins = [plugin("late"), plugin("second", { order: 200 }), plugin("first", { order: 100 }), plugin("later")];
    const config = host({ late: {}, second: {}, first: {}, later: {} }).config;
    expect(activePlugins(plugins, config).map((p) => p.key)).toEqual(["first", "second", "late", "later"]);
  });

  it("the built-ins keep the order they have always started in", () => {
    const config = host({ stub: [{ name: "s" }], telegram: {} }).config;
    expect(activePlugins(BUILTIN_CHANNEL_PLUGINS, config).map((p) => p.key)).toEqual(["telegram", "stub"]);

    // Plugin channels at 200 and 300 start between telegram and the stubs.
    const withPlugins = [...BUILTIN_CHANNEL_PLUGINS, plugin("workspace", { order: 300 }), plugin("mud", { order: 200 })];
    const config2 = host({ stub: [{ name: "s" }], workspace: { port: 1 }, mud: {}, telegram: {} }).config;
    expect(activePlugins(withPlugins, config2).map((p) => p.key)).toEqual(["telegram", "mud", "workspace", "stub"]);
  });

  it("refuses two plugins for one key, and a plugin with no key", () => {
    expect(() => assertUniqueKeys([plugin("a"), plugin("b")])).not.toThrow();
    expect(() => assertUniqueKeys([plugin("a"), plugin("a")])).toThrow(/two channel plugins claim channels\.a/);
    expect(() => assertUniqueKeys([plugin("")])).toThrow(/without a key/);
    expect(() => assertUniqueKeys([...BUILTIN_CHANNEL_PLUGINS, plugin("telegram")])).toThrow(/channels\.telegram/);
  });

  it("creates each configured channel with its own config value and collects extension paths in order", async () => {
    const seen: unknown[] = [];
    const h = host({ one: { n: 1 }, many: [{ name: "x" }, { name: "y" }] });
    const plugins = [
      plugin("many", {
        order: 2,
        label: "Many",
        create: (cfg) => (cfg as Array<{ name: string }>).map((c) => channel(c.name)),
        extensionPaths: () => ["/ext/many"],
      }),
      plugin("one", {
        order: 1,
        label: "One",
        create: async (cfg, got) => {
          seen.push(cfg, got);
          return channel("one");
        },
        extensionPaths: (cfg) => [`/ext/one-${(cfg as { n: number }).n}`],
      }),
      plugin("absent", { extensionPaths: () => ["/ext/absent"] }),
    ];
    const { created, extensionPaths } = await createChannels(plugins, h);
    expect(seen).toEqual([{ n: 1 }, h]);
    expect(created.map((c) => c.channel.name)).toEqual(["one", "x", "y"]);
    expect(extensionPaths).toEqual(["/ext/one-1", "/ext/many"]);
    expect(created.map(channelLogName)).toEqual(["One channel", 'Many channel "x"', 'Many channel "y"']);
  });

  it("names the configured channels that no plugin provides", () => {
    const config = host({ telegram: {}, mud: { bot_name: "x" }, off: false, none: [] }).config;
    expect(unclaimedChannelKeys(BUILTIN_CHANNEL_PLUGINS, config)).toEqual(["mud"]);
    expect(unclaimedChannelKeys([...BUILTIN_CHANNEL_PLUGINS, plugin("mud")], config)).toEqual([]);
  });

  it("a plugin that cannot build its channel fails the boot", async () => {
    const boom = plugin("boom", {
      create: () => {
        throw new Error("no token");
      },
    });
    await expect(createChannels([boom], host({ boom: {} }))).rejects.toThrow("no token");
  });

  it("telegram brings its outbound extension unless the agent turned it off", () => {
    const telegram = BUILTIN_CHANNEL_PLUGINS.find((p) => p.key === "telegram")!;
    const h = host({});
    expect(telegram.extensionPaths!({ bot_token: "x" }, h)).toHaveLength(1);
    expect(telegram.extensionPaths!({ bot_token: "x" }, h)[0]).toMatch(/extensions\/spindle-telegram$/);
    expect(telegram.extensionPaths!({ bot_token: "x", outbound_tools: false }, h)).toEqual([]);
  });
});
