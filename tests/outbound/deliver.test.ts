import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindTelegramChannel } from "../../src/channels/telegram/binding";
import { MediaLog, bindMediaLog } from "../../src/media/log";
import { OutboundLog, bindOutboundLog, deliver, fromContext, getOutboundLog } from "../../src/outbound";

let dir = "";
const sent: string[] = [];
function fakeTelegram(fail = false) {
  return {
    sendText: async (t: string) => {
      if (fail) throw new Error("telegram down");
      sent.push(`text:${t}`);
    },
    sendImage: async (p: string) => (sent.push(`image:${p}`), { path: p, bytes: 4 }),
    sendAudio: async (p: string) => (sent.push(`audio:${p}`), { path: p, bytes: 4 }),
    sendVoice: async (p: string) => (sent.push(`voice:${p}`), { path: p, bytes: 4 }),
  };
}
const ctxFor = (session: string, first: string, name?: string) => ({
  sessionManager: {
    getSessionId: () => session,
    getSessionName: () => name,
    getEntries: () => [{ type: "message", message: { role: "user", content: [{ type: "text", text: first }] } }],
  },
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "outbound-"));
  sent.length = 0;
  bindMediaLog(new MediaLog(join(dir, "media.jsonl")));
  bindOutboundLog(new OutboundLog(join(dir, "outbound.jsonl")));
  bindTelegramChannel(fakeTelegram() as never);
});
afterEach(() => {
  bindMediaLog(null);
  bindOutboundLog(null);
  bindTelegramChannel(null as never);
  rmSync(dir, { recursive: true, force: true });
});

describe("deliver", () => {
  it("pushes a text to Telegram and records it under the session that sent it", async () => {
    const d = await deliver({ kind: "text", text: "Nina closed out", from: fromContext(ctxFor("bg-1", "/juno-auto run next"), "call_1") });
    expect(sent).toEqual(["text:Nina closed out"]);
    expect(d).toMatchObject({ kind: "text", text: "Nina closed out", push: ["telegram"], from: { session: "bg-1", label: "/juno-auto", toolCallId: "call_1" } });
    expect(d.id).toMatch(/^dl_[0-9a-f]{12}$/);
    expect(getOutboundLog()!.all().map((x) => x.id)).toEqual([d.id]);
  });

  it("a file is registered in the media log with the sender's session and tool call, not the media log's own context", async () => {
    const png = join(dir, "chart.png");
    writeFileSync(png, "x");
    const media = new MediaLog(join(dir, "m2.jsonl"));
    media.setContext(() => ({ session: "main", toolCallId: "main_call" }));
    bindMediaLog(media);
    const d = await deliver({ kind: "image", path: png, caption: "rhythm", from: fromContext(ctxFor("bg-2", "/juno-auto"), "bg_call") });
    const m = media.get(d.media!)!;
    expect(m).toMatchObject({ session: "bg-2", toolCallId: "bg_call", caption: "rhythm", via: "telegram", mime: "image/png" });
    expect(d).toMatchObject({ kind: "image", media: m.id, mime: "image/png", caption: "rhythm" });
  });

  it("a failed push throws as before and records nothing", async () => {
    bindTelegramChannel(fakeTelegram(true) as never);
    await expect(deliver({ kind: "text", text: "x", from: { session: "s" } })).rejects.toThrow("telegram down");
    expect(getOutboundLog()!.all()).toEqual([]);
  });

  it("no Telegram bound: a push is refused, a delivery with no push target is still recorded", async () => {
    bindTelegramChannel(null as never);
    await expect(deliver({ kind: "text", text: "x", from: { session: "s" } })).rejects.toThrow(/not available/);
    const d = await deliver({ kind: "text", text: "for the workspace", from: { session: "s" }, push: [] });
    expect(d.push).toEqual([]);
    expect(getOutboundLog()!.all()).toHaveLength(1);
  });

  it("the label prefers the session's name, falls back to its first command, else none", () => {
    expect(fromContext(ctxFor("s", "/nightly-review now", "Nightly sweep")).label).toBe("Nightly sweep");
    expect(fromContext(ctxFor("s", "  /sync-notes")).label).toBe("/sync-notes");
    expect(fromContext(ctxFor("s", "hello there")).label).toBeUndefined();
    expect(fromContext(undefined)).toEqual({ session: null });
  });

  it("is reachable through the process-wide slot, for agent extensions outside spindle", async () => {
    const viaSlot = (globalThis as any)[Symbol.for("@spindle/deliver")];
    expect(viaSlot).toBe(deliver);
  });
});

describe("destinations served by reading the log", () => {
  it("are registered by name and gone once removed", async () => {
    const o = await import("../../src/outbound");
    expect(o.hasDestination("workspace")).toBe(false);
    o.registerDestination("workspace");
    expect(o.hasDestination("workspace")).toBe(true);
    expect(o.hasDestination("other")).toBe(false);
    o.unregisterDestination("workspace");
    expect(o.hasDestination("workspace")).toBe(false);
  });
});
