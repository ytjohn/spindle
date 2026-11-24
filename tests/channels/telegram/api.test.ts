import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TelegramApi, classifyTelegramError } from "../../../src/channels/telegram/api";
import { TelegramApiError } from "../../../src/channels/telegram/types";

function mockFetchOnce(status: number, body: unknown): void {
  // Construct a fresh Response on each call so bodies aren't consumed twice.
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        })
    )
  );
}

function mockFetchSequence(responses: Array<{ status: number; body: unknown }>): ReturnType<typeof vi.fn> {
  let i = 0;
  const fn = vi.fn(async () => {
    const spec = responses[i++];
    if (!spec) throw new Error("fetch called more times than expected");
    return new Response(JSON.stringify(spec.body), {
      status: spec.status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("classifyTelegramError", () => {
  it("classifies 401 as auth and connection-affecting", () => {
    const err = classifyTelegramError("getMe", 401, "Unauthorized");
    expect(err.failureClass).toBe("auth");
    expect(err.connectionAffecting).toBe(true);
  });

  it("classifies 429 as transport and connection-affecting", () => {
    const err = classifyTelegramError("sendMessage", 429, "Too Many Requests");
    expect(err.failureClass).toBe("transport");
    expect(err.connectionAffecting).toBe(true);
  });

  it("classifies 5xx as transport and connection-affecting", () => {
    const err = classifyTelegramError("getUpdates", 503, "Service Unavailable");
    expect(err.failureClass).toBe("transport");
    expect(err.connectionAffecting).toBe(true);
  });

  it("classifies message-is-not-modified as message error (not connection-affecting)", () => {
    const err = classifyTelegramError("editMessageText", 400, "Message is not modified");
    expect(err.failureClass).toBe("message");
    expect(err.connectionAffecting).toBe(false);
  });

  it("classifies 408 as timeout", () => {
    const err = classifyTelegramError("getUpdates", 408, "Request Timeout");
    expect(err.failureClass).toBe("timeout");
  });
});

describe("TelegramApi", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("getMe returns the bot user", async () => {
    mockFetchOnce(200, {
      ok: true,
      result: { id: 42, is_bot: true, username: "eliza_bot", first_name: "Eliza" },
    });
    const api = new TelegramApi("test-token");
    const me = await api.getMe();
    expect(me.id).toBe(42);
    expect(me.username).toBe("eliza_bot");
  });

  it("sendMessage sends text and returns the message", async () => {
    const fetchFn = mockFetchSequence([
      { status: 200, body: { ok: true, result: { message_id: 100, chat: { id: 1 } } } },
    ]);
    const api = new TelegramApi("test-token");
    const msg = await api.sendMessage(1, "hello");
    expect(msg.message_id).toBe(100);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/bot");
    expect(url).toContain("/sendMessage");
    const body = JSON.parse(init.body as string);
    expect(body.chat_id).toBe(1);
    expect(body.text).toBe("hello");
  });

  it("getUpdates returns updates array with offset and timeout in body", async () => {
    const fetchFn = mockFetchSequence([
      {
        status: 200,
        body: {
          ok: true,
          result: [
            { update_id: 1, message: { message_id: 1, chat: { id: 1 }, text: "hi" } },
          ],
        },
      },
    ]);
    const api = new TelegramApi("test-token");
    const updates = await api.getUpdates(5, 30);
    expect(updates).toHaveLength(1);
    expect(updates[0].update_id).toBe(1);
    const body = JSON.parse((fetchFn.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.offset).toBe(5);
    expect(body.timeout).toBe(30);
    expect(body.allowed_updates).toEqual(["message", "edited_message"]);
  });

  it("throws TelegramApiError with auth failureClass on 401", async () => {
    mockFetchOnce(401, { ok: false, error_code: 401, description: "Unauthorized" });
    const api = new TelegramApi("bad-token");
    await expect(api.getMe()).rejects.toBeInstanceOf(TelegramApiError);
    try {
      await api.getMe();
    } catch (err) {
      expect((err as TelegramApiError).failureClass).toBe("auth");
      expect((err as TelegramApiError).connectionAffecting).toBe(true);
    }
  });

  it("throws TelegramApiError with network failureClass on fetch rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      })
    );
    const api = new TelegramApi("test-token");
    await expect(api.getMe()).rejects.toBeInstanceOf(TelegramApiError);
  });

  it("propagates AbortError without wrapping", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      })
    );
    const api = new TelegramApi("test-token");
    await expect(api.getMe()).rejects.toThrowError("aborted");
  });

  it("setMyCommands posts commands and optional scope", async () => {
    const fetchFn = mockFetchSequence([{ status: 200, body: { ok: true, result: true } }]);
    const api = new TelegramApi("test-token");
    const ok = await api.setMyCommands(
      [{ command: "help", description: "Show help" }],
      { type: "chat", chat_id: 123 }
    );
    expect(ok).toBe(true);
    const body = JSON.parse((fetchFn.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.commands).toEqual([{ command: "help", description: "Show help" }]);
    expect(body.scope).toEqual({ type: "chat", chat_id: 123 });
  });

  it("editMessageText sends correct body", async () => {
    const fetchFn = mockFetchSequence([
      { status: 200, body: { ok: true, result: { message_id: 55, chat: { id: 1 } } } },
    ]);
    const api = new TelegramApi("test-token");
    await api.editMessageText(1, 55, "updated text");
    const body = JSON.parse((fetchFn.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.chat_id).toBe(1);
    expect(body.message_id).toBe(55);
    expect(body.text).toBe("updated text");
  });

  it("getFile returns file info", async () => {
    mockFetchOnce(200, {
      ok: true,
      result: { file_id: "abc", file_unique_id: "abc_u", file_path: "photos/file_0.jpg" },
    });
    const api = new TelegramApi("test-token");
    const file = await api.getFile("abc");
    expect(file.file_path).toBe("photos/file_0.jpg");
  });
});
