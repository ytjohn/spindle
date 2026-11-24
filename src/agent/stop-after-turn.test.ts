import { beforeEach, describe, expect, test } from "vitest";
import {
  _resetStopAfterTurn, consumeStopAfterTurn, installStopAfterTurn, requestStopAfterTurn,
  setQueuedHandler,
} from "./stop-after-turn";

describe("stop-after-turn", () => {
  beforeEach(() => _resetStopAfterTurn());

  test("refuses without a host hook, so the caller can fall back", () => {
    expect(requestStopAfterTurn("mud_wait")).toBe(false);
    expect(consumeStopAfterTurn()).toBeNull();
  });

  test("an installed hook stops once, for the turn that asked", async () => {
    const agent: { shouldStopAfterTurn?: (c?: unknown, s?: AbortSignal) => boolean | Promise<boolean> } = {};
    installStopAfterTurn(agent);
    expect(await agent.shouldStopAfterTurn!()).toBe(false);
    expect(requestStopAfterTurn("mud_wait")).toBe(true);
    expect(await agent.shouldStopAfterTurn!()).toBe(true);
    expect(await agent.shouldStopAfterTurn!()).toBe(false);
  });

  test("chains a hook that was already there", async () => {
    let asked = 0;
    const agent: { shouldStopAfterTurn?: (c?: unknown, s?: AbortSignal) => boolean | Promise<boolean> } = {
      shouldStopAfterTurn: () => { asked++; return true; },
    };
    installStopAfterTurn(agent);
    expect(await agent.shouldStopAfterTurn!()).toBe(true);
    expect(asked).toBe(1);
  });

  type QAgent = {
    followUpQueue: { messages: unknown[] };
    steered: unknown[];
    steer: (m: never) => void;
    shouldStopAfterTurn?: (c?: unknown, s?: AbortSignal) => boolean | Promise<boolean>;
  };
  const qAgent = (messages: unknown[]): QAgent => {
    const a = { followUpQueue: { messages }, steered: [] as unknown[] } as QAgent;
    a.steer = (m: never) => { a.steered.push(m); };
    return a;
  };

  test("everything held: stop, with nothing left queued to continue on", async () => {
    const agent = qAgent(["passer-by", "another"]);
    installStopAfterTurn(agent);
    setQueuedHandler(() => []);
    // An ordinary turn end does not touch the queue.
    expect(await agent.shouldStopAfterTurn!()).toBe(false);
    expect(agent.followUpQueue.messages).toEqual(["passer-by", "another"]);
    requestStopAfterTurn("mud_wait");
    expect(await agent.shouldStopAfterTurn!()).toBe(true);
    expect(agent.followUpQueue.messages).toEqual([]);
    expect(agent.steered).toEqual([]);
  });

  test("something wakes: do not stop, deliver it as steering", async () => {
    const agent = qAgent(["passer-by", "page"]);
    installStopAfterTurn(agent);
    setQueuedHandler((q) => q.filter((m) => m === "page"));
    requestStopAfterTurn("mud_wait");
    expect(await agent.shouldStopAfterTurn!()).toBe(false);
    expect(agent.followUpQueue.messages).toEqual([]);
    expect(agent.steered).toEqual(["page"]);
  });

  test("a throwing handler leaves the queue as it was", async () => {
    const agent = qAgent(["a"]);
    installStopAfterTurn(agent);
    setQueuedHandler(() => { throw new Error("boom"); });
    requestStopAfterTurn("mud_wait");
    expect(await agent.shouldStopAfterTurn!()).toBe(true);
    expect(agent.followUpQueue.messages).toEqual(["a"]);
  });
});
