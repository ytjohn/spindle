import { describe, it, expect } from "vitest";
import { runUntilSettled, type SettleSession } from "../../src/scheduler/settle";

/**
 * A fake session that replays a pi event sequence after prompt() returns,
 * the way an extension's fire-and-forget pi.sendMessage(triggerTurn) does.
 * Each step is [delayMs, event].
 */
function fakeSession(steps: Array<[number, unknown]>, streaming = true) {
  const listeners = new Set<(e: unknown) => void>();
  let finished = false;
  const s: SettleSession = {
    isStreaming: streaming,
    subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    async prompt() {
      (async () => {
        for (const [ms, e] of steps) {
          await new Promise((r) => setTimeout(r, ms));
          for (const l of listeners) l(e);
        }
        finished = true;
      })();
    },
  };
  return { s, isFinished: () => finished };
}

const ok = { type: "message_end", message: { role: "assistant" } };
const err = (m: string) => ({ type: "message_end", message: { role: "assistant", errorMessage: m } });
const END = { type: "agent_end" };
const SETTLED = { type: "agent_settled" };
const RETRY = { type: "auto_retry_start" };

describe("runUntilSettled", () => {
  it("a clean run: resolves on agent_settled with no error", async () => {
    const f = fakeSession([[1, ok], [1, END], [1, SETTLED]]);
    const r = await runUntilSettled(f.s, "/x", 5_000);
    expect(r).toMatchObject({ turnEnded: true, turnError: undefined, retries: 0, timedOut: false });
  });

  it("does NOT stop at the failed attempt's agent_end when pi retries", async () => {
    // pi: failed reply, agent_end, THEN decides to retry, recovers, settles.
    const f = fakeSession([
      [1, err("Stream ended without finish_reason")], [1, END],
      [5, RETRY], [20, ok], [1, END], [1, SETTLED],
    ]);
    const r = await runUntilSettled(f.s, "/juno-auto", 5_000, { graceMs: 1_000 });
    expect(f.isFinished()).toBe(true);           // waited for the whole sequence
    expect(r.retries).toBe(1);
    expect(r.turnError).toBeUndefined();         // the retry recovered the run
  });

  it("reports the error when pi's retries are exhausted", async () => {
    const f = fakeSession([
      [1, err("503 Service Unavailable")], [1, END], [2, RETRY],
      [2, err("503 Service Unavailable")], [1, END], [1, SETTLED],
    ]);
    const r = await runUntilSettled(f.s, "/x", 5_000, { graceMs: 1_000 });
    expect(r.retries).toBe(1);
    expect(r.turnError).toBe("503 Service Unavailable");
  });

  it("an unretried error still resolves once the run settles", async () => {
    const f = fakeSession([[1, err("An error occurred during streaming")], [1, END], [1, SETTLED]]);
    const r = await runUntilSettled(f.s, "/x", 5_000);
    expect(r.turnError).toBe("An error occurred during streaming");
    expect(r.retries).toBe(0);
  });

  it("falls back to agent_end + grace when pi never emits agent_settled", async () => {
    const f = fakeSession([[1, ok], [1, END]]);
    const t0 = Date.now();
    const r = await runUntilSettled(f.s, "/x", 5_000, { graceMs: 50 });
    expect(r.turnEnded).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("returns immediately when no LLM turn started", async () => {
    const f = fakeSession([], false);
    const r = await runUntilSettled(f.s, "/deterministic", 5_000);
    expect(r).toMatchObject({ turnEnded: false, timedOut: false });
  });

  it("times out a run that never ends", async () => {
    const f = fakeSession([[1, ok]]);
    const r = await runUntilSettled(f.s, "/x", 60);
    expect(r.timedOut).toBe(true);
  });
});
