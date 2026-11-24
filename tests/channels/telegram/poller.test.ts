import { describe, it, expect, vi } from "vitest";
import { TelegramPoller } from "../../../src/channels/telegram/poller";
import { TelegramApiError, type TelegramUpdate } from "../../../src/channels/telegram/types";
import type { TelegramApi } from "../../../src/channels/telegram/api";

/**
 * Creates a mock TelegramApi whose `getUpdates` returns queued responses in
 * order. Each response is either an updates array or an Error to throw.
 * After responses are exhausted, getUpdates blocks forever (simulating a
 * long poll waiting on a real server) until aborted.
 */
function createMockApi(responses: Array<TelegramUpdate[] | Error>): {
  api: TelegramApi;
  getUpdatesCalls: Array<{ offset: number | undefined; timeout: number }>;
} {
  const getUpdatesCalls: Array<{ offset: number | undefined; timeout: number }> = [];
  let i = 0;

  const getUpdates = vi.fn(
    async (
      offset: number | undefined,
      timeout: number,
      signal?: AbortSignal
    ): Promise<TelegramUpdate[]> => {
      getUpdatesCalls.push({ offset, timeout });
      if (i < responses.length) {
        const spec = responses[i++];
        if (spec instanceof Error) throw spec;
        return spec;
      }
      // No more scripted responses — block until aborted
      return new Promise<TelegramUpdate[]>((_, reject) => {
        signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }
  );

  const api = { getUpdates } as unknown as TelegramApi;
  return { api, getUpdatesCalls };
}

function update(update_id: number, text: string): TelegramUpdate {
  return {
    update_id,
    message: { message_id: update_id, chat: { id: 1 }, text },
  };
}

// Utility: await all pending microtasks so the poll loop can make progress
async function flush(times: number = 3): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("TelegramPoller", () => {
  it("calls getUpdates with undefined offset on first poll", async () => {
    const { api, getUpdatesCalls } = createMockApi([[]]);
    const poller = new TelegramPoller({ api, onUpdate: async () => {} });
    poller.start();
    await flush();
    await poller.stop();
    expect(getUpdatesCalls[0].offset).toBeUndefined();
  });

  it("advances offset after processing updates", async () => {
    const { api, getUpdatesCalls } = createMockApi([
      [update(10, "first"), update(11, "second")],
      [],
    ]);
    const received: TelegramUpdate[] = [];
    const poller = new TelegramPoller({
      api,
      onUpdate: async (u) => {
        received.push(u);
      },
    });
    poller.start();
    await flush(5);
    await poller.stop();

    expect(received.map((u) => u.update_id)).toEqual([10, 11]);
    // Second call should have offset = 12 (last update_id + 1)
    expect(getUpdatesCalls[1].offset).toBe(12);
  });

  it("first poll uses warmup timeout of 0, subsequent polls use configured timeout", async () => {
    const { api, getUpdatesCalls } = createMockApi([[], []]);
    const poller = new TelegramPoller({
      api,
      onUpdate: async () => {},
      pollTimeoutSeconds: 20,
    });
    poller.start();
    await flush(5);
    await poller.stop();

    expect(getUpdatesCalls[0].timeout).toBe(0);
    expect(getUpdatesCalls[1].timeout).toBe(20);
  });

  it("invokes onConnected once after first successful poll", async () => {
    const { api } = createMockApi([[], []]);
    const onConnected = vi.fn();
    const poller = new TelegramPoller({ api, onUpdate: async () => {}, onConnected });
    poller.start();
    await flush(5);
    await poller.stop();
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it("stop() cancels the in-flight long poll", async () => {
    // No scripted responses — getUpdates blocks forever
    const { api } = createMockApi([]);
    const poller = new TelegramPoller({ api, onUpdate: async () => {} });
    poller.start();
    expect(poller.isRunning).toBe(true);
    await poller.stop();
    expect(poller.isRunning).toBe(false);
  });

  it("stops permanently on auth error and calls onError", async () => {
    const authError = new TelegramApiError("Unauthorized", {
      failureClass: "auth",
      connectionAffecting: true,
      operation: "getUpdates",
      status: 401,
    });
    const { api, getUpdatesCalls } = createMockApi([authError]);
    const onError = vi.fn();
    const poller = new TelegramPoller({ api, onUpdate: async () => {}, onError });
    poller.start();
    await flush(5);
    await poller.stop();

    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as TelegramApiError).failureClass).toBe("auth");
    // Only one call to getUpdates — no retry after auth failure
    expect(getUpdatesCalls).toHaveLength(1);
  });

  it("retries after transient (network) errors", async () => {
    const networkError = new TelegramApiError("ECONNREFUSED", {
      failureClass: "network",
      connectionAffecting: true,
      operation: "getUpdates",
    });
    const { api, getUpdatesCalls } = createMockApi([networkError, [update(1, "ok")]]);
    const onError = vi.fn();
    const received: TelegramUpdate[] = [];
    const poller = new TelegramPoller({
      api,
      onUpdate: async (u) => {
        received.push(u);
      },
      onError,
      retryIntervalMs: 1, // fast for test
    });
    poller.start();
    await flush(20);
    await poller.stop();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(getUpdatesCalls.length).toBeGreaterThanOrEqual(2);
    expect(received[0]?.update_id).toBe(1);
  });

  it("swallows errors from onUpdate handler and continues", async () => {
    const { api } = createMockApi([[update(1, "first"), update(2, "second")], []]);
    const onError = vi.fn();
    const processed: number[] = [];
    const poller = new TelegramPoller({
      api,
      onUpdate: async (u) => {
        processed.push(u.update_id);
        if (u.update_id === 1) throw new Error("handler failed");
      },
      onError,
    });
    poller.start();
    await flush(5);
    await poller.stop();

    expect(processed).toEqual([1, 2]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("restarting poller creates a new generation", async () => {
    const { api } = createMockApi([[update(1, "a")], [update(2, "b")]]);
    const received: number[] = [];
    const poller = new TelegramPoller({
      api,
      onUpdate: async (u) => {
        received.push(u.update_id);
      },
    });
    poller.start();
    await flush(5);
    await poller.stop();
    poller.start();
    await flush(5);
    await poller.stop();
    expect(received).toEqual([1, 2]);
  });

  it("isRunning reflects state", async () => {
    const { api } = createMockApi([]);
    const poller = new TelegramPoller({ api, onUpdate: async () => {} });
    expect(poller.isRunning).toBe(false);
    poller.start();
    expect(poller.isRunning).toBe(true);
    await poller.stop();
    expect(poller.isRunning).toBe(false);
  });
});
