import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { TelegramChannel } from "../../../src/channels/telegram/channel";
import { resetTelegramBinding } from "../../../src/channels/telegram/binding";
import type { AgentConfig } from "../../../src/types";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

/**
 * Tests for TelegramChannel.sendVoice — the voice-note transport behind
 * the `telegram_send_voice` tool and the auto-send path for speech.
 *
 * sendVoice shares resolveOutboundFile with sendImage/sendAudio, so the
 * traversal guard is re-asserted here rather than assumed: it is a
 * security boundary, and a future refactor could give the voice path its
 * own resolution without any other test noticing.
 *
 * Mirrors sendImage.test.ts: the TelegramApi is built inside start(), so
 * fetch is scripted to intercept the real HTTP calls.
 */

function mockFetchByUrl(routes: Record<string, () => Response>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    for (const substring of Object.keys(routes)) {
      if (url.includes(substring)) {
        return routes[substring]();
      }
    }
    // Unmatched — park until aborted (simulates the getUpdates long-poll)
    return new Promise<Response>((_, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
        return;
      }
      signal?.addEventListener(
        "abort",
        () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        },
        { once: true }
      );
    });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const defaultRoutes = () => ({
  "/getMe": () => json({ ok: true, result: { id: 1, is_bot: true, username: "test_bot" } }),
  "/sendVoice": () => json({ ok: true, result: { message_id: 99 } }),
  "/sendAudio": () => json({ ok: true, result: { message_id: 98 } }),
  "/sendMessage": () => json({ ok: true, result: { message_id: 100 } }),
});

function makeSession(): AgentSession {
  const subscribers: Array<(event: unknown) => void> = [];
  const session = {
    prompt: vi.fn(async () => {}),
    subscribe: (cb: (event: unknown) => void) => {
      subscribers.push(cb);
      return () => {
        const idx = subscribers.indexOf(cb);
        if (idx !== -1) subscribers.splice(idx, 1);
      };
    },
  };
  return session as unknown as AgentSession;
}

function baseConfig(): AgentConfig {
  return {
    agent: { id: "test" },
    channels: {
      telegram: { bot_token: "test-token", allowed_users: ["42"] },
    },
  };
}

/** Lock in a chatId without routing a real inbound message. */
function withChat(ch: TelegramChannel): TelegramChannel {
  (ch as unknown as { chatId: number | null }).chatId = 100;
  return ch;
}

describe("TelegramChannel.sendVoice", () => {
  let tmpDir: string;
  let filesDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "spindle-sendvoice-"));
    filesDir = join(tmpDir, "files");
    mkdirSync(filesDir, { recursive: true });
    writeFileSync(join(filesDir, "say.ogg"), Buffer.from("OggS fake opus payload"));
    writeFileSync(join(tmpDir, "outside.ogg"), Buffer.from("OggS elsewhere"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetTelegramBinding();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects before chatId is locked in", async () => {
    mockFetchByUrl(defaultRoutes());
    const ch = new TelegramChannel({ agentDir: tmpDir, config: baseConfig() });
    await ch.start(makeSession(), baseConfig());
    await expect(ch.sendVoice("say.ogg")).rejects.toThrow(/chat not yet locked in/);
    await ch.stop();
  });

  it("rejects path traversal outside filesDir", async () => {
    mockFetchByUrl(defaultRoutes());
    const ch = new TelegramChannel({ agentDir: tmpDir, config: baseConfig() });
    await ch.start(makeSession(), baseConfig());
    withChat(ch);
    await expect(ch.sendVoice("../outside.ogg")).rejects.toThrow(/outside filesDir/);
    await ch.stop();
  });

  it("rejects missing files", async () => {
    mockFetchByUrl(defaultRoutes());
    const ch = new TelegramChannel({ agentDir: tmpDir, config: baseConfig() });
    await ch.start(makeSession(), baseConfig());
    withChat(ch);
    await expect(ch.sendVoice("nonexistent.ogg")).rejects.toThrow(/File not found/);
    await ch.stop();
  });

  it("posts to /sendVoice with caption and duration", async () => {
    const fetchFn = mockFetchByUrl(defaultRoutes());
    const ch = new TelegramChannel({ agentDir: tmpDir, config: baseConfig() });
    await ch.start(makeSession(), baseConfig());
    withChat(ch);
    await ch.sendVoice("say.ogg", "thinking out loud", { duration: 9.4 });

    const calls = fetchFn.mock.calls.filter((c) => String(c[0]).includes("/sendVoice"));
    expect(calls).toHaveLength(1);
    const init = calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = init.body as FormData;
    expect(body.get("chat_id")).toBe("100");
    expect(body.get("caption")).toBe("thinking out loud");
    // Telegram wants an integer; 9.4s of speech must not arrive as "9.4".
    expect(body.get("duration")).toBe("9");
    // The file rides in the `voice` field — `audio` would render the
    // music player instead of the voice bubble.
    expect(body.get("voice")).toBeInstanceOf(Blob);
    expect((body.get("voice") as Blob).type).toBe("audio/ogg");
    await ch.stop();
  });

  it("never posts to /sendAudio", async () => {
    const fetchFn = mockFetchByUrl(defaultRoutes());
    const ch = new TelegramChannel({ agentDir: tmpDir, config: baseConfig() });
    await ch.start(makeSession(), baseConfig());
    withChat(ch);
    await ch.sendVoice("say.ogg");
    expect(
      fetchFn.mock.calls.filter((c) => String(c[0]).includes("/sendAudio"))
    ).toHaveLength(0);
    await ch.stop();
  });

  it("omits caption and duration when not supplied", async () => {
    const fetchFn = mockFetchByUrl(defaultRoutes());
    const ch = new TelegramChannel({ agentDir: tmpDir, config: baseConfig() });
    await ch.start(makeSession(), baseConfig());
    withChat(ch);
    await ch.sendVoice("say.ogg");
    const calls = fetchFn.mock.calls.filter((c) => String(c[0]).includes("/sendVoice"));
    const body = (calls[0][1] as RequestInit).body as FormData;
    expect(body.get("caption")).toBeNull();
    expect(body.get("duration")).toBeNull();
    await ch.stop();
  });

  it("accepts an absolute path inside filesDir", async () => {
    const fetchFn = mockFetchByUrl(defaultRoutes());
    const ch = new TelegramChannel({ agentDir: tmpDir, config: baseConfig() });
    await ch.start(makeSession(), baseConfig());
    withChat(ch);
    await ch.sendVoice(resolve(filesDir, "say.ogg"));
    expect(
      fetchFn.mock.calls.filter((c) => String(c[0]).includes("/sendVoice"))
    ).toHaveLength(1);
    await ch.stop();
  });

  it("surfaces a Telegram API error rather than resolving silently", async () => {
    mockFetchByUrl({
      ...defaultRoutes(),
      "/sendVoice": () =>
        json({ ok: false, error_code: 400, description: "VOICE_MESSAGES_FORBIDDEN" }, 400),
    });
    const ch = new TelegramChannel({ agentDir: tmpDir, config: baseConfig() });
    await ch.start(makeSession(), baseConfig());
    withChat(ch);
    await expect(ch.sendVoice("say.ogg")).rejects.toThrow(/VOICE_MESSAGES_FORBIDDEN/);
    await ch.stop();
  });
});
