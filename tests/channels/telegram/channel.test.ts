import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProvenanceTracker, type TrackerSession } from "../../../src/provenance/tracker";
import { bindProvenanceTracker } from "../../../src/provenance/binding";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TelegramChannel, splitForTelegram } from "../../../src/channels/telegram/channel";
import type { AgentConfig } from "../../../src/types";
import { hasFfmpeg, startStubAsr, toneWav } from "../../fixtures/asr-stub-server";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

// The tracker binding is process-wide. Tests that build their own session
// fakes (paused sessions, watchdog cases) must not inherit a tracker bound
// to an earlier fake, or dispatch would prompt the wrong session. With no
// tracker bound the channel falls back to session.prompt directly.
beforeEach(() => bindProvenanceTracker(null));

/**
 * Mock fetch that scripts Telegram responses in order. Used by TelegramApi
 * (which the real channel instantiates under the hood). Lets us drive
 * end-to-end behavior without touching real HTTP.
 */
interface FetchResponse {
  status: number;
  body: unknown;
}

// Captured at module evaluation, before any test stubs the global. A test
// that scripted Telegram but needs real HTTP for one URL (the stub ASR
// server, or a port with nothing on it) has to be able to name the real
// fetch — grabbing globalThis.fetch later grabs the mock and hangs.
const NATIVE_FETCH = globalThis.fetch;

function mockFetchScript(responses: FetchResponse[]): ReturnType<typeof vi.fn> {
  let i = 0;
  const fn = vi.fn(async (_url: string, init?: RequestInit) => {
    if (i < responses.length) {
      const spec = responses[i++];
      return new Response(JSON.stringify(spec.body), {
        status: spec.status,
        headers: { "content-type": "application/json" },
      });
    }
    // After scripted responses, simulate Telegram's long-poll behavior:
    // hold the request open until the caller aborts it. Rejecting with an
    // AbortError lets the poller exit cleanly when `stop()` is called.
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

// Canonical "getMe" response used when a test doesn't care.
const GET_ME_OK = {
  status: 200,
  body: { ok: true, result: { id: 1, is_bot: true, username: "test_bot" } },
};

function makeSession(options: { respondWith?: string } = {}): AgentSession {
  // Minimal AgentSession mock: just enough surface for TelegramChannel.
  // After prompt() is called, emits a synthetic text_start + text_delta +
  // message_end sequence so the channel's event subscriber sees a complete
  // turn and unbusies without any polling.
  const subscribers: Array<(event: unknown) => void> = [];
  const emit = (event: unknown) => {
    for (const cb of subscribers) cb(event);
  };

  // Minimal session-manager fake so the ProvenanceTracker can persist
  // den.origin entries the way pi does (message entry appended right
  // after message_end listeners return).
  const entries: Array<{ type: string; id: string; customType?: string; message?: unknown }> = [];
  const sessionManager = {
    appendCustomEntry: (customType: string) => {
      const id = `e${entries.length + 1}`;
      entries.push({ type: "custom", id, customType });
      return id;
    },
    getLeafEntry: () => entries[entries.length - 1],
    getEntries: () => entries,
  };

  const session = {
    prompt: vi.fn(async (text: string) => {
      // Schedule turn completion on the next microtask so the channel's
      // `busy = true` assignment happens first. Replays pi's run shape:
      // before_agent_start (tracker.openRun), agent_start, the user
      // message, the assistant text, agent_end.
      queueMicrotask(() => {
        tracker.openRun(text);
        emit({ type: "agent_start" });
        const user = { role: "user", content: [{ type: "text", text }] };
        emit({ type: "message_start", message: user });
        emit({ type: "message_end", message: user });
        entries.push({ type: "message", id: `e${entries.length + 1}`, message: user });
        if (options.respondWith) {
          emit({
            type: "message_update",
            assistantMessageEvent: { type: "text_start" },
          });
          emit({
            type: "message_update",
            assistantMessageEvent: {
              type: "text_delta",
              delta: options.respondWith,
            },
          });
        }
        emit({ type: "message_end", message: {} });
        emit({ type: "agent_end", messages: [] });
      });
    }),
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
    sessionManager,
  };
  // The channel resolves run ownership through the process-wide tracker
  // binding, exactly as it does in production.
  const tracker = new ProvenanceTracker(session as unknown as TrackerSession);
  bindProvenanceTracker(tracker);
  return session as unknown as AgentSession;
}

function baseConfig(allowedUsers: AgentConfig["channels"] extends infer C
  ? C extends { telegram?: infer T }
    ? T extends { allowed_users?: infer A }
      ? A
      : never
    : never
  : never): AgentConfig {
  return {
    agent: { id: "test" },
    channels: {
      telegram: {
        bot_token: "test-token",
        allowed_users: allowedUsers,
      },
    },
  };
}

function update(updateId: number, text: string, senderId: number, chatId = 100): {
  update_id: number;
  message: {
    message_id: number;
    from: { id: number; is_bot: boolean };
    chat: { id: number };
    text: string;
  };
} {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: senderId, is_bot: false },
      chat: { id: chatId },
      text,
    },
  };
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 5));
}

describe("splitForTelegram", () => {
  it("returns single chunk when under limit", () => {
    expect(splitForTelegram("hello")).toEqual(["hello"]);
  });

  it("splits long text on newline boundaries", () => {
    const long = "a".repeat(3000) + "\n\n" + "b".repeat(3000);
    const chunks = splitForTelegram(long, 4000);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Each chunk fits within limit
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(4000);
  });

  it("hard-splits when no natural boundary", () => {
    const long = "x".repeat(8000);
    const chunks = splitForTelegram(long, 4000);
    expect(chunks.length).toBe(2);
  });
});

describe("TelegramChannel", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "spindle-tg-test-"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("validates bot token on start (calls getMe)", async () => {
    mockFetchScript([GET_ME_OK]);
    const channel = new TelegramChannel({ agentDir: tmpDir });
    const session = makeSession();
    await channel.start(session, baseConfig(["12345"]));
    await channel.stop();
  });

  it("calls session.bindExtensions at boot, not on first message", async () => {
    // Pi emits `session_start` inside bindExtensions() — extensions
    // that schedule their own work (background pollers, interval
    // loops) don't start until session_start fires. Binding at
    // boot (rather than on first allowed message) makes those
    // schedulers start running immediately, so background behavior
    // isn't paused waiting for a user message.
    mockFetchScript([GET_ME_OK]);
    const channel = new TelegramChannel({ agentDir: tmpDir });
    const session = makeSession() as AgentSession & {
      bindExtensions: ReturnType<typeof vi.fn>;
    };
    session.bindExtensions = vi.fn(async () => {});

    await channel.start(session, baseConfig(["12345"]));
    try {
      // bindExtensions must have been called before start() resolved —
      // i.e. before any poller update could have arrived.
      expect(session.bindExtensions).toHaveBeenCalledTimes(1);
      // Called with a uiContext + commandContextActions pair.
      const args = session.bindExtensions.mock.calls[0][0] as {
        uiContext?: unknown;
        commandContextActions?: unknown;
      };
      expect(args.uiContext).toBeDefined();
      expect(args.commandContextActions).toBeDefined();
    } finally {
      await channel.stop();
    }
  });

  it("does not re-bind extensions when the first allowed message arrives", async () => {
    // If bindExtensions ran twice, pi would re-emit session_start and
    // every extension's session_start handler would fire twice —
    // double-scheduling any setInterval loops. Pin the single-call
    // contract explicitly.
    mockFetchScript([
      GET_ME_OK,
      { status: 200, body: { ok: true, result: [update(1, "hello", 12345)] } },
    ]);
    const channel = new TelegramChannel({ agentDir: tmpDir });
    const session = makeSession() as AgentSession & {
      bindExtensions: ReturnType<typeof vi.fn>;
    };
    session.bindExtensions = vi.fn(async () => {});

    await channel.start(session, baseConfig(["12345"]));
    await flush();
    await channel.stop();

    expect(session.bindExtensions).toHaveBeenCalledTimes(1);
  });

  it("routes pre-chat-id notifies to stdout instead of dropping them", async () => {
    // Extensions' session_start handlers may call ctx.ui.notify() at
    // boot (e.g. "Calendar loaded", "Scheduler started") —
    // before any user message has locked in a chat. The Telegram
    // channel's notify closure falls back to a console.log tagged
    // with [telegram] pre-chat so these operational messages surface
    // in journalctl.
    mockFetchScript([GET_ME_OK]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const channel = new TelegramChannel({ agentDir: tmpDir });
    const session = makeSession() as AgentSession & {
      bindExtensions: ReturnType<typeof vi.fn>;
    };
    // Capture the notify closure pi would have called from session_start.
    let capturedNotify: ((message: string, type?: string) => void) | null = null;
    session.bindExtensions = vi.fn(async (bindings: unknown) => {
      const b = bindings as {
        uiContext?: { notify?: (m: string, t?: string) => void };
      };
      capturedNotify = b.uiContext?.notify ?? null;
    });

    try {
      await channel.start(session, baseConfig(["12345"]));
      expect(capturedNotify).not.toBeNull();
      // Simulate an extension's session_start handler calling notify
      // before any user message has set chatId.
      capturedNotify!("Calendar loaded (1 entries).");
      // Allow the fire-and-forget sendResponse chain to complete.
      await flush(3);
      const preChatLogs = logSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.includes("[telegram] pre-chat"));
      expect(preChatLogs.length).toBeGreaterThan(0);
      expect(preChatLogs.some((s) => s.includes("Calendar loaded"))).toBe(true);
    } finally {
      logSpy.mockRestore();
      await channel.stop();
    }
  });

  it("rejects start if bot token is invalid", async () => {
    mockFetchScript([
      { status: 401, body: { ok: false, error_code: 401, description: "Unauthorized" } },
    ]);
    const channel = new TelegramChannel({ agentDir: tmpDir });
    const session = makeSession();
    await expect(channel.start(session, baseConfig(["12345"]))).rejects.toThrow();
  });

  // --- transient startup failure must not kill the channel ---
  //
  // Reproduces a real failure: the systemd --user unit starts at boot
  // before the network is reachable, so the initial getMe() throws. The
  // old code aborted start() before poller.start() and nothing ever
  // retried — the process stayed healthy while Telegram was dead for up
  // to 24 hours, until a human restarted the service.

  it("survives an unreachable network at startup and delivers once it recovers", async () => {
    // First call (getMe) fails the way an unroutable network does: fetch
    // itself throws, which telegramRequest wraps as failureClass "network".
    // Every later call succeeds, standing in for the network coming up.
    let call = 0;
    const fn = vi.fn(async (_url: string, init?: RequestInit) => {
      call++;
      if (call === 1) throw new Error("Unable to connect. Is the computer able to access the url?");
      if (call === 2) {
        return new Response(
          JSON.stringify({ ok: true, result: [update(1, "hello", 12345)] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        const abort = () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (signal?.aborted) return abort();
        signal?.addEventListener("abort", abort, { once: true });
      });
    });
    vi.stubGlobal("fetch", fn);

    const channel = new TelegramChannel({ agentDir: tmpDir });
    const session = makeSession();

    // The whole point: this must NOT throw.
    await expect(channel.start(session, baseConfig(["12345"]))).resolves.toBeUndefined();
    await flush();

    // And the poller must have started despite the failed getMe, polled
    // successfully, and delivered the waiting message.
    expect(call).toBeGreaterThanOrEqual(2);
    expect((session.prompt as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1);
    expect((session.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("[telegram] hello");

    await channel.stop();
  });

  it("keeps auth failure fatal — a revoked token must not degrade silently", async () => {
    // Counterpart to the above: a 401 means Telegram *answered*, so the
    // network worked and the token really is bad. Retrying cannot fix it,
    // so start() must still reject rather than starting a doomed poller.
    let call = 0;
    const fn = vi.fn(async () => {
      call++;
      return new Response(
        JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fn);

    const channel = new TelegramChannel({ agentDir: tmpDir });
    const session = makeSession();
    await expect(channel.start(session, baseConfig(["12345"]))).rejects.toThrow();
    // Exactly one call: getMe. The poller was never started.
    expect(call).toBe(1);
  });

  it("dispatches text message from allowed user to session", async () => {
    mockFetchScript([
      GET_ME_OK,
      { status: 200, body: { ok: true, result: [update(1, "hello", 12345)] } },
    ]);
    const channel = new TelegramChannel({ agentDir: tmpDir });
    const session = makeSession();
    await channel.start(session, baseConfig(["12345"]));
    await flush();
    await channel.stop();
    expect((session.prompt as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1);
    // Non-slash text is tagged with the source channel so channel-aware
    // extensions can route responses (see dispatchToSession).
    expect((session.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("[telegram] hello");
  });

  it("drops message from non-allowed user", async () => {
    mockFetchScript([
      GET_ME_OK,
      { status: 200, body: { ok: true, result: [update(1, "hello", 99999)] } },
    ]);
    const channel = new TelegramChannel({ agentDir: tmpDir });
    const session = makeSession();
    await channel.start(session, baseConfig(["12345"]));
    await flush();
    await channel.stop();
    expect((session.prompt as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("accepts extended allowed_users object form", async () => {
    mockFetchScript([
      GET_ME_OK,
      { status: 200, body: { ok: true, result: [update(1, "hi", 12345)] } },
    ]);
    const channel = new TelegramChannel({ agentDir: tmpDir });
    const session = makeSession();
    await channel.start(
      session,
      baseConfig([{ id: "12345", access: "full" }])
    );
    await flush();
    await channel.stop();
    expect((session.prompt as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects bot senders even if user ID is allowed", async () => {
    const botMessage = {
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: 12345, is_bot: true },
        chat: { id: 100 },
        text: "hello from bot",
      },
    };
    mockFetchScript([
      GET_ME_OK,
      { status: 200, body: { ok: true, result: [botMessage] } },
    ]);
    const channel = new TelegramChannel({ agentDir: tmpDir });
    const session = makeSession();
    await channel.start(session, baseConfig(["12345"]));
    await flush();
    await channel.stop();
    expect((session.prompt as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("sends assistant response text back to Telegram", async () => {
    const fetchFn = mockFetchScript([
      GET_ME_OK,
      { status: 200, body: { ok: true, result: [update(1, "ping", 12345)] } },
      { status: 200, body: { ok: true, result: { message_id: 999, chat: { id: 100 } } } },
    ]);
    const channel = new TelegramChannel({ agentDir: tmpDir });
    const session = makeSession({ respondWith: "pong!" });
    await channel.start(session, baseConfig(["12345"]));
    await flush(15);
    await channel.stop();

    const sendCall = fetchFn.mock.calls.find(([url]) =>
      (url as string).includes("/sendMessage")
    );
    expect(sendCall).toBeDefined();
    const body = JSON.parse((sendCall![1] as RequestInit).body as string);
    expect(body.text).toBe("pong!");
    expect(body.chat_id).toBe(100);
  });

  it("queues additional messages while busy and drains FIFO", async () => {
    // Session is paused: prompt() starts "streaming" but the test controls
    // when each turn completes. Simulates a real LLM call that holds the
    // session in busy/streaming state until the turn finishes.
    const subscribers: Array<(event: unknown) => void> = [];
    const emit = (e: unknown) => {
      for (const cb of subscribers) cb(e);
    };
    let pendingCompletions = 0;
    const promptCalls: string[] = [];

    const sessionState = {
      prompt: vi.fn(async (text: string) => {
        promptCalls.push(text);
        pendingCompletions++;
        // A real pi session flips isStreaming to true when a turn starts.
        // The channel's watchdog relies on this to decide whether a turn
        // is in progress.
        sessionState.isStreaming = true;
      }),
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
    const session = sessionState as unknown as AgentSession;

    const complete = async () => {
      sessionState.isStreaming = false;
      emit({ type: "message_end", message: {} });
      pendingCompletions--;
      await flush(3);
    };

    mockFetchScript([
      GET_ME_OK,
      {
        status: 200,
        body: {
          ok: true,
          result: [
            update(1, "first", 12345),
            update(2, "second", 12345),
            update(3, "third", 12345),
          ],
        },
      },
    ]);

    const channel = new TelegramChannel({ agentDir: tmpDir });
    await channel.start(session, baseConfig(["12345"]));
    await flush(10);

    // Only the first message should have been dispatched; the other two
    // should be queued while the session is "busy". Non-slash text is
    // tagged with the source channel (see dispatchToSession).
    expect(promptCalls).toEqual(["[telegram] first"]);

    // Complete the first turn — drain should dispatch the next queued item.
    await complete();
    expect(promptCalls).toEqual(["[telegram] first", "[telegram] second"]);

    await complete();
    expect(promptCalls).toEqual(["[telegram] first", "[telegram] second", "[telegram] third"]);

    await complete();
    await channel.stop();
    expect(pendingCompletions).toBe(0);
  });

  // An agent can run a game channel and telegram on ONE session, so a
  // game turn holds the session while the channel's own `busy` flag is
  // false. Every path to session.prompt() has to check isStreaming, not
  // just busy, or pi throws "Agent is already processing" at the user.
  it("queues while a foreign turn holds the session, and drains on agent_end", async () => {
    const subscribers: Array<(event: unknown) => void> = [];
    const emit = (e: unknown) => {
      for (const cb of subscribers) cb(e);
    };
    const promptCalls: string[] = [];

    const sessionState = {
      prompt: vi.fn(async (text: string) => {
        promptCalls.push(text);
        sessionState.isStreaming = true;
      }),
      subscribe: (cb: (event: unknown) => void) => {
        subscribers.push(cb);
        return () => {
          const idx = subscribers.indexOf(cb);
          if (idx !== -1) subscribers.splice(idx, 1);
        };
      },
      // A game-channel turn is already in flight before Telegram sees anything.
      isStreaming: true,
      isCompacting: false,
      isRetrying: false,
    };
    const session = sessionState as unknown as AgentSession;

    mockFetchScript([
      GET_ME_OK,
      {
        status: 200,
        body: { ok: true, result: [update(1, "you there?", 12345)] },
      },
    ]);

    const channel = new TelegramChannel({ agentDir: tmpDir });
    await channel.start(session, baseConfig(["12345"]));
    await flush(10);

    // The channel is not busy, but the session is. Must not prompt.
    expect(promptCalls).toEqual([]);

    // A game turn emits message_end per assistant message while the run
    // continues. The drain that fires there must not dispatch either,
    // and must not consume the queued message.
    emit({ type: "message_end", message: {} });
    await flush(3);
    expect(promptCalls).toEqual([]);

    // Run over: isStreaming clears in the agent's finally block, after
    // agent_end listeners return — hence the deferred drain.
    emit({ type: "agent_end", messages: [] });
    sessionState.isStreaming = false;
    await flush(3);
    expect(promptCalls).toEqual(["[telegram] you there?"]);

    await channel.stop();
  });

  // Waiting for idle alone starved the operator's texts for an hour behind
  // back-to-back game-channel runs. The channel now publishes that a text
  // is waiting, and the game channel holds its events until it has gone.
  it("publishes a pending text while it waits, and clears it once dispatched", async () => {
    const { getTelegramPendingMs } = await import("../../../src/channels/telegram/binding");
    const subscribers: Array<(event: unknown) => void> = [];
    const emit = (e: unknown) => {
      for (const cb of subscribers) cb(e);
    };
    const sessionState = {
      prompt: vi.fn(async () => {
        sessionState.isStreaming = true;
      }),
      subscribe: (cb: (event: unknown) => void) => {
        subscribers.push(cb);
        return () => {
          const idx = subscribers.indexOf(cb);
          if (idx !== -1) subscribers.splice(idx, 1);
        };
      },
      isStreaming: true,
      isCompacting: false,
      isRetrying: false,
    };
    const session = sessionState as unknown as AgentSession;
    mockFetchScript([
      GET_ME_OK,
      { status: 200, body: { ok: true, result: [update(1, "you there?", 12345)] } },
    ]);

    const channel = new TelegramChannel({ agentDir: tmpDir });
    await channel.start(session, baseConfig(["12345"]));
    await flush(10);
    expect(getTelegramPendingMs()).toBeGreaterThan(0);

    emit({ type: "agent_end", messages: [] });
    sessionState.isStreaming = false;
    await flush(3);
    expect(sessionState.prompt).toHaveBeenCalledTimes(1);
    expect(getTelegramPendingMs()).toBe(0);

    await channel.stop();
  });

  it("passes streamingBehavior so a bypassed guard queues instead of throwing", async () => {
    const session = makeSession();
    mockFetchScript([
      GET_ME_OK,
      { status: 200, body: { ok: true, result: [update(1, "hi", 12345)] } },
    ]);

    const channel = new TelegramChannel({ agentDir: tmpDir });
    await channel.start(session, baseConfig(["12345"]));
    await flush(10);
    await channel.stop();

    expect(session.prompt).toHaveBeenCalledWith("[telegram] hi", {
      streamingBehavior: "followUp",
    });
  });

  it("does not send empty/whitespace-only turns to Telegram", async () => {
    // Session emits a tool-call-only turn: text_start, no delta, message_end.
    // No sendMessage call should be made.
    const subscribers: Array<(event: unknown) => void> = [];
    const emit = (e: unknown) => {
      for (const cb of subscribers) cb(e);
    };

    const session = {
      prompt: vi.fn(async () => {
        queueMicrotask(() => {
          // Tool-call-only turn: text_start with no deltas, then message_end
          emit({
            type: "message_update",
            assistantMessageEvent: { type: "text_start" },
          });
          emit({ type: "message_end", message: {} });
        });
      }),
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
    } as unknown as AgentSession;

    const fetchFn = mockFetchScript([
      GET_ME_OK,
      { status: 200, body: { ok: true, result: [update(1, "hi", 12345)] } },
    ]);

    const channel = new TelegramChannel({ agentDir: tmpDir });
    await channel.start(session, baseConfig(["12345"]));
    await flush(15);
    await channel.stop();

    const sendMessageCalls = fetchFn.mock.calls.filter(([url]) =>
      (url as string).includes("/sendMessage")
    );
    expect(sendMessageCalls).toHaveLength(0);
  });

  it("watchdog unsticks busy state if prompt returns without a turn", async () => {
    // Simulates pi's behavior when text starting with "/" is intercepted
    // as an extension command: prompt() returns without firing any events
    // and without entering the streaming state. Without the watchdog,
    // busy would stay true and subsequent messages would queue forever.
    const subscribers: Array<(event: unknown) => void> = [];
    const emit = (e: unknown) => {
      for (const cb of subscribers) cb(e);
    };

    const promptCalls: string[] = [];
    const session = {
      prompt: vi.fn(async (text: string) => {
        promptCalls.push(text);
        // Return immediately without any event fired, without streaming.
        // This is what pi does when an extension command is handled.
      }),
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
    } as unknown as AgentSession;

    mockFetchScript([
      GET_ME_OK,
      {
        status: 200,
        body: {
          ok: true,
          result: [update(1, "/ping", 12345), update(2, "hello after", 12345)],
        },
      },
    ]);

    const channel = new TelegramChannel({ agentDir: tmpDir });
    await channel.start(session, baseConfig(["12345"]));
    await flush(20);
    await channel.stop();

    // Both messages should have been dispatched — the watchdog unblocked
    // the queue after the first prompt returned early without streaming.
    // Slash commands pass through untagged; plain text gets the
    // [telegram] source tag (see dispatchToSession).
    expect(promptCalls).toEqual(["/ping", "[telegram] hello after"]);
    // Silence unused-var lint — emit is kept as scaffolding for future tests
    emit;
  });

  it("does not send whitespace-only response text (e.g. newlines)", async () => {
    const fetchFn = mockFetchScript([
      GET_ME_OK,
      { status: 200, body: { ok: true, result: [update(1, "hi", 12345)] } },
    ]);
    const channel = new TelegramChannel({ agentDir: tmpDir });
    const session = makeSession({ respondWith: "\n\n  \n" });
    await channel.start(session, baseConfig(["12345"]));
    await flush(15);
    await channel.stop();

    const sendMessageCalls = fetchFn.mock.calls.filter(([url]) =>
      (url as string).includes("/sendMessage")
    );
    expect(sendMessageCalls).toHaveLength(0);
  });

  it("calls session.bindExtensions with a UI adapter that routes notify to Telegram", async () => {
    // Capture whatever uiContext the channel binds so we can drive it
    // the same way pi's command handler would — by calling notify().
    let boundUiContext: { notify?: (msg: string, level?: string) => void } | null = null;

    const subscribers: Array<(event: unknown) => void> = [];
    const session = {
      prompt: vi.fn(async () => {
        queueMicrotask(() => {
          for (const cb of subscribers) cb({ type: "message_end", message: {} });
        });
      }),
      subscribe: (cb: (event: unknown) => void) => {
        subscribers.push(cb);
        return () => {
          const idx = subscribers.indexOf(cb);
          if (idx !== -1) subscribers.splice(idx, 1);
        };
      },
      bindExtensions: vi.fn(async (bindings: { uiContext?: unknown }) => {
        boundUiContext = bindings.uiContext as typeof boundUiContext;
      }),
      isStreaming: false,
      isCompacting: false,
      isRetrying: false,
    } as unknown as AgentSession;

    const fetchFn = mockFetchScript([
      GET_ME_OK,
      { status: 200, body: { ok: true, result: [update(1, "/ping", 12345)] } },
      { status: 200, body: { ok: true, result: { message_id: 999, chat: { id: 100 } } } },
    ]);

    const channel = new TelegramChannel({ agentDir: tmpDir });
    await channel.start(session, baseConfig(["12345"]));
    await flush(15);

    // Extension command handler would do this during execution:
    boundUiContext?.notify?.("pong", "info");
    await flush(5);
    await channel.stop();

    expect(
      (session as unknown as { bindExtensions: ReturnType<typeof vi.fn> }).bindExtensions
    ).toHaveBeenCalled();

    const sendCall = fetchFn.mock.calls.find(([url]) =>
      (url as string).includes("/sendMessage")
    );
    expect(sendCall).toBeDefined();
    const body = JSON.parse((sendCall![1] as RequestInit).body as string);
    expect(body.text).toBe("pong");
    expect(body.chat_id).toBe(100);
  });

  it("gracefully degrades when session.bindExtensions is missing (older SDK)", async () => {
    // Session has no bindExtensions method at all — channel should still
    // start and process messages, just log a warning instead of crashing.
    mockFetchScript([
      GET_ME_OK,
      { status: 200, body: { ok: true, result: [update(1, "hi", 12345)] } },
    ]);
    const channel = new TelegramChannel({ agentDir: tmpDir });
    const session = makeSession({ respondWith: "ok" });
    // Sanity: our makeSession helper does NOT provide bindExtensions
    expect((session as unknown as { bindExtensions?: unknown }).bindExtensions).toBeUndefined();

    await channel.start(session, baseConfig(["12345"]));
    await flush(15);
    await channel.stop();
    // No crash = pass
  });

  it("registers slash commands with Telegram after first allowed message", async () => {
    const fetchFn = mockFetchScript([
      GET_ME_OK,
      { status: 200, body: { ok: true, result: [update(1, "hi", 12345)] } },
      { status: 200, body: { ok: true, result: true } }, // setMyCommands
    ]);
    const channel = new TelegramChannel({ agentDir: tmpDir });
    const session = makeSession({ respondWith: "hello" });
    const getSlashCommands = vi.fn(() => [
      { name: "weather", description: "Show weather", source: "extension" as const },
      { name: "mood", description: "Show mood", source: "extension" as const },
    ]);

    await channel.start(session, baseConfig(["12345"]), getSlashCommands);
    await flush(15);
    await channel.stop();

    expect(getSlashCommands).toHaveBeenCalled();
    const setMyCommandsCall = fetchFn.mock.calls.find(([url]) =>
      (url as string).includes("/setMyCommands")
    );
    expect(setMyCommandsCall).toBeDefined();
    const body = JSON.parse((setMyCommandsCall![1] as RequestInit).body as string);
    // Merged list: local commands (compact, session) + pi extension commands
    const names = (body.commands as Array<{ command: string }>).map((c) => c.command);
    expect(names).toContain("compact");
    expect(names).toContain("session");
    expect(names).toContain("weather");
    expect(names).toContain("mood");
    // /new is excluded from defaults — see newSessionCommand docs
    expect(names).not.toContain("new");
    expect(body.scope).toEqual({ type: "chat", chat_id: 100 });
  });

  it("intercepts a registered /new as a local command — does not call session.prompt", async () => {
    const newSession = vi.fn(async () => true);
    const session = {
      prompt: vi.fn(async () => {}),
      subscribe: () => () => {},
      newSession,
      isStreaming: false,
      isCompacting: false,
      isRetrying: false,
    } as unknown as AgentSession;

    const fetchFn = mockFetchScript([
      GET_ME_OK,
      { status: 200, body: { ok: true, result: [update(1, "/new", 12345)] } },
      { status: 200, body: { ok: true, result: { message_id: 999, chat: { id: 100 } } } },
    ]);

    const channel = new TelegramChannel({ agentDir: tmpDir });
    // /new is intentionally NOT in the default set — register it explicitly
    // to prove the interception path still works for app-specific commands.
    const { newSessionCommand } = await import(
      "../../../src/channels/telegram/local-commands"
    );
    channel.localCommands.register(newSessionCommand);

    await channel.start(session, baseConfig(["12345"]));
    await flush(15);
    await channel.stop();

    // /new handled locally — prompt NOT called. AgentSession.newSession()
    // was removed in pi 0.70+, so the handler replies "not supported"
    // instead of resetting the session (see newSessionCommand).
    expect(newSession).not.toHaveBeenCalled();
    expect((session.prompt as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);

    // And the channel sent the not-supported notice back to the chat
    const sendCall = fetchFn.mock.calls.find(([url]) =>
      (url as string).includes("/sendMessage")
    );
    expect(sendCall).toBeDefined();
    const body = JSON.parse((sendCall![1] as RequestInit).body as string);
    expect(body.text).toMatch(/not supported/i);
  });

  it("default command set does not include /new (intentional)", async () => {
    mockFetchScript([
      GET_ME_OK,
      { status: 200, body: { ok: true, result: [update(1, "hi", 12345)] } },
      { status: 200, body: { ok: true, result: true } },
    ]);
    const channel = new TelegramChannel({ agentDir: tmpDir });
    const session = makeSession({ respondWith: "ok" });
    await channel.start(session, baseConfig(["12345"]));
    await flush(15);
    await channel.stop();

    // /new should not be in the default LocalCommandRegistry
    expect(channel.localCommands.has("new")).toBe(false);
    expect(channel.localCommands.has("compact")).toBe(true);
    expect(channel.localCommands.has("session")).toBe(true);
  });

  it("includes local commands in the Telegram autocomplete setMyCommands list", async () => {
    const fetchFn = mockFetchScript([
      GET_ME_OK,
      { status: 200, body: { ok: true, result: [update(1, "hi", 12345)] } },
      { status: 200, body: { ok: true, result: true } },
    ]);
    const channel = new TelegramChannel({ agentDir: tmpDir });
    const session = makeSession({ respondWith: "ok" });
    await channel.start(session, baseConfig(["12345"]));
    await flush(15);
    await channel.stop();

    const setCmdCall = fetchFn.mock.calls.find(([url]) =>
      (url as string).includes("/setMyCommands")
    );
    expect(setCmdCall).toBeDefined();
    const body = JSON.parse((setCmdCall![1] as RequestInit).body as string);
    const names = (body.commands as Array<{ command: string }>).map((c) => c.command);
    expect(names).toContain("compact");
    expect(names).toContain("session");
    // /new is intentionally excluded — see newSessionCommand docs
    expect(names).not.toContain("new");
  });

  // Voice notes: three outcomes, and only one of them is a conversation.
  // A file that was downloaded and kept but could not be read is our bad
  // day, not the sender's — see handleVoice's `{ drop: "silent" }`.
  const voiceUpdate = {
    update_id: 1,
    message: {
      message_id: 1,
      from: { id: 12345, is_bot: false },
      chat: { id: 100 },
      voice: { file_id: "v1", file_unique_id: "v1u", duration: 3 },
    },
  };
  const getFileOk = {
    status: 200,
    body: { ok: true, result: { file_id: "v1", file_unique_id: "v1u", file_path: "files/voice_1.ogg" } },
  };

  /**
   * A Telegram mock that answers by endpoint rather than by script order.
   * The voice path also fires setMyCommands and downloads a file, so an
   * ordered script drifts the moment anything else sends a request — which is
   * exactly how the first version of these tests hung.
   *
   * Anything that is NOT Telegram goes to the real fetch: that is how the stub
   * ASR server gets reached, and how "nothing is listening on that port" is
   * tested as a real connection refusal instead of a scripted lookalike.
   * downloadFile answers with decodable PCM, since the mock's JSON would make
   * every transcription fail for the wrong reason.
   */
  function voiceFetch() {
    const realFetch = NATIVE_FETCH.bind(globalThis);
    let delivered = false;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const fn = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (!u.includes("api.telegram.org")) return realFetch(u, init as never);
      if (u.includes("/getMe")) return json(GET_ME_OK.body);
      if (u.includes("/getFile")) return json(getFileOk.body);
      // Files are served from /file/bot<token>/<path>; the verb "downloadFile"
      // only exists in the client.
      if (u.includes("/file/bot")) return new Response(toneWav(), { status: 200 });
      if (u.includes("/getUpdates")) {
        if (!delivered) {
          delivered = true;
          return json({ ok: true, result: [voiceUpdate] });
        }
        // Empty long-poll: hold until the poller aborts on stop().
        return new Promise<Response>((_, reject) => {
          const abort = () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          };
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      // setMyCommands, sendMessage, everything else we do not care about here.
      return json({ ok: true, result: true });
    });
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("polite reply on unsupported file kind (video note)", async () => {
    const videoNote = {
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: 12345, is_bot: false },
        chat: { id: 100 },
        video_note: { file_id: "n1", file_unique_id: "n1u" },
      },
    };
    // Order: getMe, getUpdates (returns video note), sendMessage (polite reply)
    const fetchFn = mockFetchScript([
      GET_ME_OK,
      { status: 200, body: { ok: true, result: [videoNote] } },
      { status: 200, body: { ok: true, result: { message_id: 999, chat: { id: 100 } } } },
    ]);
    const channel = new TelegramChannel({ agentDir: tmpDir });
    const session = makeSession();
    await channel.start(session, baseConfig(["12345"]));
    await flush(20);
    await channel.stop();

    // Find the sendMessage call
    const sendMessageCall = fetchFn.mock.calls.find(([url]) =>
      (url as string).includes("/sendMessage")
    );
    expect(sendMessageCall).toBeDefined();
    const body = JSON.parse((sendMessageCall![1] as RequestInit).body as string);
    expect(body.text).toMatch(/can't handle/i);
    // Session should not have been prompted
    expect((session.prompt as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("asr.enabled false: voice keeps the old polite reply and nothing else", async () => {
    const fetchFn = voiceFetch();
    const channel = new TelegramChannel({ agentDir: tmpDir });
    const session = makeSession();
    await channel.start(session, { ...baseConfig(["12345"]), asr: { enabled: false } });
    await flush(20);
    await channel.stop();

    const sendMessageCall = fetchFn.mock.calls.find(([url]) =>
      (url as string).includes("/sendMessage")
    );
    expect(sendMessageCall).toBeDefined();
    expect(JSON.parse((sendMessageCall![1] as RequestInit).body as string).text).toMatch(/can't handle/i);
    expect((session.prompt as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it.skipIf(!hasFfmpeg())("voice note: the transcript arrives as the message text", async () => {
    const stub = await startStubAsr(() => ({
      status: 200,
      body: { text: "Did the plumber come through about the gutter?" },
    }));
    try {
      const fetchFn = voiceFetch();
      const channel = new TelegramChannel({ agentDir: tmpDir });
      const session = makeSession();
      await channel.start(session, { ...baseConfig(["12345"]), asr: { endpoint: stub.endpoint } });
      await flush(30);
      await channel.stop();

      const prompts = (session.prompt as ReturnType<typeof vi.fn>).mock.calls;
      expect(prompts).toHaveLength(1);
      const text = prompts[0][0] as string;
      expect(text).toContain("Did the plumber come through about the gutter?");
      expect(text).toContain("[User sent a voice note:");
      expect(text).toContain("files/tg-1-v1u.ogg");
      // Silence means the reply was the transcript, not a complaint.
      const fetchUrls = fetchFn.mock.calls.map(([u]) => String(u));
      expect(fetchUrls.some((u) => u.includes("/sendMessage"))).toBe(false);
      // The clip itself is on disk, not just its transcript.
      expect(
        existsSync(join(tmpDir, "files", "tg-1-v1u.ogg"))
      ).toBe(true);
    } finally {
      await stub.close();
    }
  });

  it("voice note that cannot be transcribed: no prompt, and no message to the sender", async () => {
    const fetchFn = voiceFetch();
    // Nothing listening on :1 — a refused load or a dead server must not
    // turn into a text the model reads as if the sender wrote it.

    const channel = new TelegramChannel({ agentDir: tmpDir });
    const session = makeSession();
    await channel.start(session, { ...baseConfig(["12345"]), asr: { endpoint: "http://127.0.0.1:1" } });
    await flush(30);
    await channel.stop();

    expect((session.prompt as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    const fetchUrls = fetchFn.mock.calls.map(([u]) => String(u));
    expect(fetchUrls.some((u) => u.includes("/sendMessage"))).toBe(false);
  });

  // An agent once ran a 37-minute tool loop and none of the user's
  // follow-ups were even logged. Real pi's prompt() resolves only when the whole run
  // ends; dispatchToSession awaited it, and the poller awaits each update
  // handler, so the poller stopped fetching for the length of the turn. The
  // mocks above resolve prompt() at once, which is why no test caught it.
  describe("while a turn is running (prompt resolves at run end, as in pi)", () => {
    function pendingSession() {
      const subscribers: Array<(event: unknown) => void> = [];
      const emit = (e: unknown) => {
        for (const cb of subscribers) cb(e);
      };
      let finishRun: () => void = () => {};
      const state = {
        prompts: [] as string[],
        prompt: vi.fn(async (text: string) => {
          state.prompts.push(text);
          state.isStreaming = true;
          await new Promise<void>((r) => {
            finishRun = r;
          });
        }),
        abort: vi.fn(async () => {
          state.isStreaming = false;
          emit({ type: "message_end", message: {} });
          emit({ type: "agent_end", messages: [] });
          finishRun();
        }),
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
      return state;
    }

    it("keeps receiving updates and /stop aborts the running turn", async () => {
      const state = pendingSession();
      mockFetchScript([
        GET_ME_OK,
        {
          status: 200,
          body: { ok: true, result: [update(1, "go dig into the vault", 12345), update(2, "/stop", 12345)] },
        },
      ]);
      const channel = new TelegramChannel({ agentDir: tmpDir });
      await channel.start(state as unknown as AgentSession, baseConfig(["12345"]));
      await flush(10);

      expect(state.prompts).toEqual(["[telegram] go dig into the vault"]);
      expect(state.abort).toHaveBeenCalledTimes(1);
      await channel.stop();
    });

    it("queues ordinary messages behind the turn and delivers them after /stop", async () => {
      const state = pendingSession();
      mockFetchScript([
        GET_ME_OK,
        {
          status: 200,
          body: {
            ok: true,
            result: [update(1, "first", 12345), update(2, "still with me?", 12345), update(3, "/stop", 12345)],
          },
        },
      ]);
      const channel = new TelegramChannel({ agentDir: tmpDir });
      await channel.start(state as unknown as AgentSession, baseConfig(["12345"]));
      await flush(10);

      expect(state.abort).toHaveBeenCalledTimes(1);
      expect(state.prompts).toEqual(["[telegram] first", "[telegram] still with me?"]);
      await channel.stop();
    });

    it("/stop with nothing running does not abort", async () => {
      const state = pendingSession();
      mockFetchScript([
        GET_ME_OK,
        { status: 200, body: { ok: true, result: [update(1, "/stop", 12345)] } },
      ]);
      const channel = new TelegramChannel({ agentDir: tmpDir });
      await channel.start(state as unknown as AgentSession, baseConfig(["12345"]));
      await flush(10);

      expect(state.abort).not.toHaveBeenCalled();
      expect(state.prompts).toEqual([]);
      await channel.stop();
    });
  });
});

// An agent texted the user with telegram_send_message, thought for over
// five seconds, ran two more tools, then wrote a note to itself ("Answered
// with full provenance…"). The flush fallback fired in the pause and its
// resetProgress() cleared textedThisRun, so the note went to the phone as a
// second message. The guard must last the whole run.
describe("one reply per run survives the flush fallback", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tg-texted-"));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not relay text written after a send, even past a fallback flush", async () => {
    const subscribers: Array<(event: unknown) => void> = [];
    const emit = (e: unknown) => {
      for (const cb of subscribers) cb(e);
    };
    const entries: Array<{ type: string; id: string; customType?: string; message?: unknown }> = [];
    const sessionState = {
      prompt: vi.fn(async (text: string) => {
        queueMicrotask(() => {
          tracker.openRun(text);
          sessionState.isStreaming = true;
          emit({ type: "agent_start" });
          const user = { role: "user", content: [{ type: "text", text }] };
          emit({ type: "message_start", message: user });
          emit({ type: "message_end", message: user });
          entries.push({ type: "message", id: `e${entries.length + 1}`, message: user });
        });
      }),
      subscribe: (cb: (event: unknown) => void) => {
        subscribers.push(cb);
        return () => subscribers.splice(subscribers.indexOf(cb), 1);
      },
      isStreaming: false,
      isCompacting: false,
      isRetrying: false,
      sessionManager: {
        appendCustomEntry: (customType: string) => {
          const id = `e${entries.length + 1}`;
          entries.push({ type: "custom", id, customType });
          return id;
        },
        getLeafEntry: () => entries[entries.length - 1],
        getEntries: () => entries,
      },
    };
    const tracker = new ProvenanceTracker(sessionState as unknown as TrackerSession);
    bindProvenanceTracker(tracker);

    // Every Bot API call answers, except later polls, which hang as a long poll does.
    let polls = 0;
    let msgId = 100;
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("/getMe")) return json(GET_ME_OK.body);
      if (url.includes("/getUpdates")) {
        if (polls++ === 0) return json({ ok: true, result: [update(1, "what is COLI_PARK?", 12345)] });
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
        });
      }
      return json({ ok: true, result: { message_id: msgId++ } });
    });
    vi.stubGlobal("fetch", fetchFn);
    const channel = new TelegramChannel({ agentDir: dir });
    (channel as unknown as { flushFallbackMs: number }).flushFallbackMs = 20;
    await channel.start(sessionState as unknown as AgentSession, baseConfig(["12345"]));
    await flush(10);
    expect(sessionState.prompt).toHaveBeenCalled();

    // The send: a tool-calling assistant message, then the tool runs.
    emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_start" } });
    emit({ type: "message_end", message: { role: "assistant", content: [] } });
    emit({ type: "tool_execution_start", toolName: "telegram_send_message", toolCallId: "c1", args: { message: "It's from your clipping." } });
    emit({ type: "tool_execution_end", toolName: "telegram_send_message", toolCallId: "c1", result: {} });
    emit({ type: "message_end", message: { role: "toolResult", toolCallId: "c1", content: [] } });

    // A long think: the fallback fires (20 ms here, 5 s live).
    await flush(10);

    // More tools, then the note to itself, then the run ends.
    emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_start" } });
    emit({ type: "message_end", message: { role: "assistant", content: [] } });
    emit({ type: "tool_execution_start", toolName: "vault_append", toolCallId: "c2", args: {} });
    emit({ type: "tool_execution_end", toolName: "vault_append", toolCallId: "c2", result: {} });
    emit({ type: "message_end", message: { role: "toolResult", toolCallId: "c2", content: [] } });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_start" } });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Answered with full provenance and owned the slip." } });
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Answered with full provenance and owned the slip." }] } });
    emit({ type: "agent_end", messages: [] });
    sessionState.isStreaming = false;
    await flush(10);

    const sent = fetchFn.mock.calls
      .filter(([url]) => /\/(sendMessage|editMessageText)$/.test(url as string))
      .map(([, init]) => JSON.parse((init as RequestInit).body as string).text as string);
    expect(sent.some((t) => t.includes("Answered with full provenance"))).toBe(false);

    await channel.stop();
  });
});
