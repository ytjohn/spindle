import { describe, it, expect, vi } from "vitest";
import {
  createTelegramUIContext,
  createStubCommandContextActions,
} from "../../../src/channels/telegram/ui-context";

describe("createTelegramUIContext", () => {
  it("routes notify() to the adapter", () => {
    const notify = vi.fn();
    const ctx = createTelegramUIContext({ notify });
    ctx.notify("hello", "info");
    expect(notify).toHaveBeenCalledWith("hello", "info");
  });

  it("notify without a type still calls the adapter", () => {
    const notify = vi.fn();
    const ctx = createTelegramUIContext({ notify });
    ctx.notify("plain");
    expect(notify).toHaveBeenCalledWith("plain", undefined);
  });

  it("select/confirm/input throw unsupported errors", async () => {
    const ctx = createTelegramUIContext({ notify: () => {} });
    await expect(ctx.select("pick", ["a", "b"])).rejects.toThrow(/select/);
    await expect(ctx.confirm("title", "body")).rejects.toThrow(/confirm/);
    await expect(ctx.input("title")).rejects.toThrow(/input/);
  });

  it("TTY-only methods are no-ops (don't throw)", () => {
    const ctx = createTelegramUIContext({ notify: () => {} });
    expect(() => ctx.setStatus("k", "v")).not.toThrow();
    expect(() => ctx.setWorkingMessage("loading")).not.toThrow();
    expect(() => ctx.setWidget("k", ["a"])).not.toThrow();
    expect(() => ctx.setFooter(undefined)).not.toThrow();
    expect(() => ctx.setHeader(undefined)).not.toThrow();
    expect(() => ctx.setTitle("t")).not.toThrow();
    expect(() => ctx.pasteToEditor("x")).not.toThrow();
    expect(() => ctx.setEditorText("x")).not.toThrow();
    expect(ctx.getEditorText()).toBe("");
    expect(ctx.getAllThemes()).toEqual([]);
    expect(ctx.getTheme("any")).toBeUndefined();
    expect(ctx.getToolsExpanded()).toBe(false);
    expect(() => ctx.setToolsExpanded(true)).not.toThrow();
  });

  it("setTheme reports failure with a helpful error", () => {
    const ctx = createTelegramUIContext({ notify: () => {} });
    const result = ctx.setTheme("dark");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Telegram channel/);
  });

  it("onTerminalInput returns a no-op unsubscribe", () => {
    const ctx = createTelegramUIContext({ notify: () => {} });
    const unsub = ctx.onTerminalInput(() => undefined);
    expect(typeof unsub).toBe("function");
    expect(() => unsub()).not.toThrow();
  });
});

describe("createStubCommandContextActions", () => {
  it("waitForIdle resolves immediately (no deadlock)", async () => {
    const actions = createStubCommandContextActions();
    await expect(actions.waitForIdle()).resolves.toBeUndefined();
  });

  it("session management actions return cancelled", async () => {
    const actions = createStubCommandContextActions();
    await expect(actions.newSession()).resolves.toEqual({ cancelled: true });
    await expect(actions.fork("entry-1")).resolves.toEqual({ cancelled: true });
    await expect(actions.navigateTree("target")).resolves.toEqual({ cancelled: true });
    await expect(actions.switchSession("/path")).resolves.toEqual({ cancelled: true });
  });

  it("reload resolves without error", async () => {
    const actions = createStubCommandContextActions();
    await expect(actions.reload()).resolves.toBeUndefined();
  });
});
