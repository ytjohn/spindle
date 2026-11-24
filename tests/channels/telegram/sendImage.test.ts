import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { TelegramChannel } from "../../../src/channels/telegram/channel";
import {
  bindTelegramChannel,
  getBoundTelegramChannel,
  resetTelegramBinding,
} from "../../../src/channels/telegram/binding";
import type { AgentConfig } from "../../../src/types";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

/**
 * Tests for TelegramChannel.sendImage and sendText — the outbound
 * surface that the spindle-telegram pi extension adapts into the
 * `telegram_send_image` / `telegram_send_message` LLM tools.
 *
 * The TelegramApi class is instantiated by the channel at start() time,
 * so to intercept the actual HTTP calls we script fetch. sendImage uses
 * sendPhoto (multipart form) and sendText uses sendMessage (JSON).
 */

/**
 * Route fetch responses by URL substring so the poller's getUpdates
 * requests don't consume responses meant for sendPhoto/sendMessage.
 * Unknown URLs (e.g. getUpdates long-poll) park until the signal is
 * aborted, matching Telegram's real behavior.
 */
function mockFetchByUrl(routes: Record<string, () => Response>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    for (const substring of Object.keys(routes)) {
      if (url.includes(substring)) {
        return routes[substring]();
      }
    }
    // Unmatched — park until aborted (simulates long-poll)
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
  "/sendPhoto": () => json({ ok: true, result: { message_id: 99 } }),
  "/sendMessage": () => json({ ok: true, result: { message_id: 100 } }),
});

function makeSession(): AgentSession {
  // Minimal AgentSession stub. sendImage/sendText don't interact with
  // the session at all (they go straight through the TelegramApi), so
  // we only need something shaped enough to pass through start().
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
    isStreaming: false,
    isCompacting: false,
    isRetrying: false,
  };
  return session as unknown as AgentSession;
}

function baseConfig(agentDir?: string): AgentConfig {
  return {
    agent: { id: "test" },
    channels: {
      telegram: {
        bot_token: "test-token",
        allowed_users: ["42"],
        ...(agentDir ? {} : {}),
      },
    },
  };
}

describe("TelegramChannel.sendImage / sendText", () => {
  let tmpDir: string;
  let filesDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "spindle-sendimage-"));
    filesDir = join(tmpDir, "files");
    mkdirSync(filesDir, { recursive: true });
    // 1x1 PNG
    writeFileSync(
      join(filesDir, "cat.png"),
      Buffer.from(
        "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D49444154789C63F80F00010101000005CF03F6D0CE8F0C0000000049454E44AE426082",
        "hex"
      )
    );
    writeFileSync(join(tmpDir, "outside.png"), Buffer.from("not an image"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetTelegramBinding();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("constructor publishes itself to the process-wide binding", () => {
    const ch = new TelegramChannel({ agentDir: tmpDir, config: baseConfig() });
    expect(getBoundTelegramChannel()).toBe(ch);
  });

  it("stop() unpublishes from the binding", async () => {
    mockFetchByUrl(defaultRoutes());
    const ch = new TelegramChannel({ agentDir: tmpDir, config: baseConfig() });
    await ch.start(makeSession(), baseConfig());
    await ch.stop();
    expect(getBoundTelegramChannel()).toBeNull();
  });

  it("sendText rejects before chatId is locked in", async () => {
    mockFetchByUrl(defaultRoutes());
    const ch = new TelegramChannel({ agentDir: tmpDir, config: baseConfig() });
    await ch.start(makeSession(), baseConfig());
    await expect(ch.sendText("hi")).rejects.toThrow(/chat not yet locked in/);
    await ch.stop();
  });

  it("sendImage rejects before chatId is locked in", async () => {
    mockFetchByUrl(defaultRoutes());
    const ch = new TelegramChannel({ agentDir: tmpDir, config: baseConfig() });
    await ch.start(makeSession(), baseConfig());
    await expect(ch.sendImage("cat.png")).rejects.toThrow(/chat not yet locked in/);
    await ch.stop();
  });

  it("sendImage rejects path traversal outside filesDir", async () => {
    mockFetchByUrl(defaultRoutes());
    const ch = new TelegramChannel({ agentDir: tmpDir, config: baseConfig() });
    await ch.start(makeSession(), baseConfig());
    // Manually flip chatId by reaching in — the public path requires a
    // real inbound message, which is not the focus of this test.
    (ch as unknown as { chatId: number | null }).chatId = 100;
    await expect(ch.sendImage("../outside.png")).rejects.toThrow(/outside filesDir/);
    await ch.stop();
  });

  it("sendImage rejects missing files", async () => {
    mockFetchByUrl(defaultRoutes());
    const ch = new TelegramChannel({ agentDir: tmpDir, config: baseConfig() });
    await ch.start(makeSession(), baseConfig());
    (ch as unknown as { chatId: number | null }).chatId = 100;
    await expect(ch.sendImage("nonexistent.png")).rejects.toThrow(/File not found/);
    await ch.stop();
  });

  it("sendImage resolves files/foo.png against filesDir and calls sendPhoto", async () => {
    const fetchFn = mockFetchByUrl(defaultRoutes());
    const ch = new TelegramChannel({ agentDir: tmpDir, config: baseConfig() });
    await ch.start(makeSession(), baseConfig());
    (ch as unknown as { chatId: number | null }).chatId = 100;
    await ch.sendImage("cat.png", "a caption");

    const sendPhotoCalls = fetchFn.mock.calls.filter((c) =>
      String(c[0]).includes("/sendPhoto")
    );
    expect(sendPhotoCalls).toHaveLength(1);
    const init = sendPhotoCalls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = init.body as FormData;
    expect(body.get("chat_id")).toBe("100");
    expect(body.get("caption")).toBe("a caption");
    await ch.stop();
  });

  it("sendImage accepts an absolute path inside filesDir", async () => {
    const fetchFn = mockFetchByUrl(defaultRoutes());
    const ch = new TelegramChannel({ agentDir: tmpDir, config: baseConfig() });
    await ch.start(makeSession(), baseConfig());
    (ch as unknown as { chatId: number | null }).chatId = 100;
    const abs = resolve(filesDir, "cat.png");
    await ch.sendImage(abs);
    expect(
      fetchFn.mock.calls.filter((c) => String(c[0]).includes("/sendPhoto"))
    ).toHaveLength(1);
    await ch.stop();
  });

  it("sendText splits long messages and calls sendMessage for each chunk", async () => {
    const fetchFn = mockFetchByUrl(defaultRoutes());
    const ch = new TelegramChannel({ agentDir: tmpDir, config: baseConfig() });
    await ch.start(makeSession(), baseConfig());
    (ch as unknown as { chatId: number | null }).chatId = 100;
    const long = "a".repeat(3000) + "\n\n" + "b".repeat(3000);
    await ch.sendText(long);
    expect(
      fetchFn.mock.calls.filter((c) => String(c[0]).includes("/sendMessage"))
    ).toHaveLength(2);
    await ch.stop();
  });

  it("files_directory config knob routes sendImage to a custom directory", async () => {
    const customFiles = join(tmpDir, "custom");
    mkdirSync(customFiles, { recursive: true });
    writeFileSync(
      join(customFiles, "pixel.png"),
      Buffer.from("89504E47", "hex")
    );
    const config: AgentConfig = {
      agent: { id: "test" },
      channels: {
        telegram: {
          bot_token: "t",
          allowed_users: ["42"],
          files_directory: customFiles,
        },
      },
    };
    mockFetchByUrl(defaultRoutes());
    const ch = new TelegramChannel({ agentDir: tmpDir, config });
    await ch.start(makeSession(), config);
    (ch as unknown as { chatId: number | null }).chatId = 100;
    await ch.sendImage("pixel.png");
    // Confirms the custom files dir was used as the resolution root.
    expect(ch.filesDirectory).toBe(customFiles);
    await ch.stop();
  });
});

describe("binding.ts", () => {
  afterEach(() => {
    resetTelegramBinding();
  });

  it("round-trips the channel reference via globalThis symbol", () => {
    const fake = { name: "telegram" } as unknown as TelegramChannel;
    bindTelegramChannel(fake);
    expect(getBoundTelegramChannel()).toBe(fake);
  });

  it("reset clears the binding", () => {
    const fake = { name: "telegram" } as unknown as TelegramChannel;
    bindTelegramChannel(fake);
    resetTelegramBinding();
    expect(getBoundTelegramChannel()).toBeNull();
  });
});
