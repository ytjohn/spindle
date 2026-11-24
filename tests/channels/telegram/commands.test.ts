import { describe, it, expect, vi } from "vitest";
import { buildBotCommands, CommandRegistrar } from "../../../src/channels/telegram/commands";
import type { SlashCommandInfo } from "../../../src/channels/types";
import type { TelegramApi } from "../../../src/channels/telegram/api";

function makeApi(): {
  api: TelegramApi;
  setMyCommands: ReturnType<typeof vi.fn>;
} {
  const setMyCommands = vi.fn(async () => true);
  const api = { setMyCommands } as unknown as TelegramApi;
  return { api, setMyCommands };
}

function cmd(name: string, description?: string, source: "extension" | "prompt" | "skill" = "extension"): SlashCommandInfo {
  return { name, description, source };
}

describe("buildBotCommands", () => {
  it("transforms valid slash commands to Telegram format", () => {
    const { commands } = buildBotCommands([
      cmd("hello", "Say hello"),
      cmd("status", "Show status"),
    ]);
    expect(commands).toEqual([
      { command: "hello", description: "Say hello" },
      { command: "status", description: "Show status" },
    ]);
  });

  it("strips leading slashes", () => {
    const { commands } = buildBotCommands([cmd("/foo", "Foo command")]);
    expect(commands[0].command).toBe("foo");
  });

  it("lowercases command names", () => {
    const { commands, rewriteMap } = buildBotCommands([cmd("Hello", "Greeting")]);
    expect(commands[0].command).toBe("hello");
    // Case-only change: pi's router is case-insensitive in practice, but
    // we track the rewrite so the original casing is preserved if the
    // extension cares about it.
    expect(rewriteMap.get("hello")).toBe("Hello");
  });

  it("normalizes hyphens to underscores and tracks the rewrite", () => {
    const { commands, rewriteMap } = buildBotCommands([
      cmd("casey-world", "World awareness preview"),
      cmd("casey-quiet", "Toggle quiet mode"),
    ]);
    expect(commands.map((c) => c.command)).toEqual(["casey_world", "casey_quiet"]);
    expect(rewriteMap.get("casey_world")).toBe("casey-world");
    expect(rewriteMap.get("casey_quiet")).toBe("casey-quiet");
  });

  it("does not populate rewriteMap for already-underscore names", () => {
    const { rewriteMap } = buildBotCommands([cmd("foo_bar", "ok")]);
    expect(rewriteMap.has("foo_bar")).toBe(false);
  });

  it("logs and skips a collision when hyphen and underscore forms both register", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { commands, rewriteMap } = buildBotCommands([
      cmd("foo_bar", "first"),
      cmd("foo-bar", "second"),
    ]);
    expect(commands).toHaveLength(1);
    expect(commands[0].command).toBe("foo_bar");
    expect(commands[0].description).toBe("first");
    expect(rewriteMap.has("foo_bar")).toBe(false);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("foo-bar"),
    );
    spy.mockRestore();
  });

  it("filters out invalid command names (spaces, empty)", () => {
    const { commands } = buildBotCommands([
      cmd("valid_name", "ok"),
      cmd("has spaces", "bad"),
      cmd("ValidButUpper", "ok after lower"),
      cmd("0valid", "ok"),
      cmd("", "bad"),
    ]);
    const names = commands.map((c) => c.command);
    expect(names).toContain("valid_name");
    expect(names).toContain("validbutupper");
    expect(names).toContain("0valid");
    expect(names).not.toContain("has spaces");
    expect(names).not.toContain("");
  });

  it("filters out command names longer than 32 chars", () => {
    const long = "a".repeat(33);
    const ok = "a".repeat(32);
    const { commands } = buildBotCommands([cmd(long, "too long"), cmd(ok, "fine")]);
    expect(commands.map((c) => c.command)).toEqual([ok]);
  });

  it("deduplicates by normalized name (first wins)", () => {
    const { commands } = buildBotCommands([
      cmd("hello", "first"),
      cmd("Hello", "second"),
      cmd("HELLO", "third"),
    ]);
    expect(commands).toHaveLength(1);
    expect(commands[0].description).toBe("first");
  });

  it("truncates long descriptions to 256 chars", () => {
    const longDesc = "x".repeat(500);
    const { commands } = buildBotCommands([cmd("foo", longDesc)]);
    expect(commands[0].description.length).toBeLessThanOrEqual(256);
    expect(commands[0].description.endsWith("…")).toBe(true);
  });

  it("falls back to source when description is missing", () => {
    const { commands } = buildBotCommands([cmd("mycmd", undefined, "skill")]);
    expect(commands[0].description).toBe("Pi: skill");
  });

  it("caps at 100 commands (Telegram limit)", () => {
    const many: SlashCommandInfo[] = [];
    for (let i = 0; i < 150; i++) many.push(cmd(`cmd_${i}`, `Command ${i}`));
    const { commands } = buildBotCommands(many);
    expect(commands).toHaveLength(100);
  });

  it("collapses whitespace in descriptions", () => {
    const { commands } = buildBotCommands([cmd("foo", "multi\n\nline  description")]);
    expect(commands[0].description).toBe("multi line description");
  });

  it("caps rewrite map entries at the same 100-command ceiling", () => {
    const many: SlashCommandInfo[] = [];
    for (let i = 0; i < 150; i++) many.push(cmd(`cmd-${i}`, `Command ${i}`));
    const { commands, rewriteMap } = buildBotCommands(many);
    expect(commands).toHaveLength(100);
    // Every kept entry has a rewrite (hyphen → underscore), and the map
    // size should never exceed commands.length.
    expect(rewriteMap.size).toBeLessThanOrEqual(100);
    for (const { command } of commands) {
      expect(rewriteMap.has(command)).toBe(true);
    }
  });
});

describe("CommandRegistrar", () => {
  it("calls setMyCommands with chat scope", async () => {
    const { api, setMyCommands } = makeApi();
    const registrar = new CommandRegistrar(api);
    await registrar.syncForChat(123, [cmd("hello", "Hi")]);
    expect(setMyCommands).toHaveBeenCalledTimes(1);
    const [commands, scope] = setMyCommands.mock.calls[0];
    expect(commands).toEqual([{ command: "hello", description: "Hi" }]);
    expect(scope).toEqual({ type: "chat", chat_id: 123 });
  });

  it("skips API call when commands haven't changed (signature cache)", async () => {
    const { api, setMyCommands } = makeApi();
    const registrar = new CommandRegistrar(api);
    await registrar.syncForChat(123, [cmd("hello", "Hi")]);
    await registrar.syncForChat(123, [cmd("hello", "Hi")]);
    expect(setMyCommands).toHaveBeenCalledTimes(1);
  });

  it("re-registers when commands change", async () => {
    const { api, setMyCommands } = makeApi();
    const registrar = new CommandRegistrar(api);
    await registrar.syncForChat(123, [cmd("hello", "Hi")]);
    await registrar.syncForChat(123, [cmd("hello", "Updated")]);
    expect(setMyCommands).toHaveBeenCalledTimes(2);
  });

  it("tracks signatures per-chat independently", async () => {
    const { api, setMyCommands } = makeApi();
    const registrar = new CommandRegistrar(api);
    await registrar.syncForChat(100, [cmd("a", "A")]);
    await registrar.syncForChat(200, [cmd("a", "A")]);
    expect(setMyCommands).toHaveBeenCalledTimes(2);
  });

  it("reset() clears the cache", async () => {
    const { api, setMyCommands } = makeApi();
    const registrar = new CommandRegistrar(api);
    await registrar.syncForChat(123, [cmd("hello", "Hi")]);
    registrar.reset();
    await registrar.syncForChat(123, [cmd("hello", "Hi")]);
    expect(setMyCommands).toHaveBeenCalledTimes(2);
  });

  it("skips setMyCommands when the command list is empty", async () => {
    // Calling setMyCommands with [] would clear any previously-registered
    // commands for the chat. If we have nothing to register, leave it alone.
    const { api, setMyCommands } = makeApi();
    const registrar = new CommandRegistrar(api);
    await registrar.syncForChat(123, []);
    expect(setMyCommands).not.toHaveBeenCalled();
  });

  it("skips setMyCommands when all commands are filtered out as invalid", async () => {
    const { api, setMyCommands } = makeApi();
    const registrar = new CommandRegistrar(api);
    await registrar.syncForChat(123, [
      cmd("has spaces", "bad"),
      cmd("", "bad"),
    ]);
    expect(setMyCommands).not.toHaveBeenCalled();
  });

  it("exposes a per-chat rewrite map via getOriginalName", async () => {
    const { api } = makeApi();
    const registrar = new CommandRegistrar(api);
    await registrar.syncForChat(123, [cmd("casey-world", "w")]);
    expect(registrar.getOriginalName(123, "casey_world")).toBe("casey-world");
    // Underscore-form names pass through — no rewrite entry
    expect(registrar.getOriginalName(123, "compact")).toBeUndefined();
  });

  it("tracks rewrite maps per chat independently", async () => {
    const { api } = makeApi();
    const registrar = new CommandRegistrar(api);
    await registrar.syncForChat(100, [cmd("alpha-beta", "ab")]);
    await registrar.syncForChat(200, [cmd("gamma-delta", "gd")]);
    expect(registrar.getOriginalName(100, "alpha_beta")).toBe("alpha-beta");
    expect(registrar.getOriginalName(100, "gamma_delta")).toBeUndefined();
    expect(registrar.getOriginalName(200, "gamma_delta")).toBe("gamma-delta");
  });

  it("refreshes the rewrite map even when the signature cache hit skips the API", async () => {
    const { api, setMyCommands } = makeApi();
    const registrar = new CommandRegistrar(api);
    await registrar.syncForChat(123, [cmd("foo-bar", "fb")]);
    // Second call with same shape — API skipped, but the map must still
    // be present after a hypothetical registrar.reset-less restart path.
    await registrar.syncForChat(123, [cmd("foo-bar", "fb")]);
    expect(setMyCommands).toHaveBeenCalledTimes(1);
    expect(registrar.getOriginalName(123, "foo_bar")).toBe("foo-bar");
  });

  it("reset clears rewrite maps", async () => {
    const { api } = makeApi();
    const registrar = new CommandRegistrar(api);
    await registrar.syncForChat(123, [cmd("casey-world", "w")]);
    registrar.reset();
    expect(registrar.getOriginalName(123, "casey_world")).toBeUndefined();
  });
});

import { _resetHiddenToolProgress, hideToolProgress, isToolProgressHidden } from "../../../src/channels/telegram/binding";

describe("tools kept out of the progress message", () => {
  it("match by exact name, or by prefix when the name ends in *", () => {
    _resetHiddenToolProgress();
    expect(isToolProgressHidden("game_move")).toBe(false);
    hideToolProgress(["game_*", "ping", "not a name", "a*b"]);
    expect(isToolProgressHidden("game_move")).toBe(true);
    expect(isToolProgressHidden("game_")).toBe(true);
    expect(isToolProgressHidden("ping")).toBe(true);
    expect(isToolProgressHidden("pinger")).toBe(false);
    expect(isToolProgressHidden("gamer")).toBe(false);
    expect(isToolProgressHidden("not a name")).toBe(false);
    _resetHiddenToolProgress();
    expect(isToolProgressHidden("ping")).toBe(false);
  });
});
