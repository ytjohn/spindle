import { describe, it, expect, vi } from "vitest";
import { ProvenanceTracker, origin, type TrackerSession } from "../../src/provenance/tracker";
import {
  ORIGIN_ENTRY_TYPE,
  RUN_END_ENTRY_TYPE,
  RUN_ENTRY_TYPE,
  type ProvenanceEvent,
} from "../../src/provenance/types";

/**
 * A fake AgentSession that replays pi 0.70's exact event and persistence
 * order (agent-session.js `_processAgentEvent` + pi-agent-core
 * `runAgentLoop`/`runLoop`):
 *
 *   prompt(text) when idle:
 *     before_agent_start (extension hook — the test calls openRun directly)
 *     agent_start, turn_start
 *     message_start(user), message_end(user) → appendMessage
 *     [assistant streaming … message_end(assistant) → appendMessage]
 *     [queued followUps: message_start/end(user) → appendMessage]
 *     agent_end
 *
 *   prompt(text, {streamingBehavior}) while streaming: queued, delivered
 *   later inside the same run; no before_agent_start.
 *
 * Persistence happens synchronously AFTER listeners for message_end,
 * which is the property the tracker's microtask relies on.
 */
function fakeSession() {
  type Entry = { type: string; id: string; customType?: string; data?: unknown; message?: unknown };
  const entries: Entry[] = [];
  let nextId = 1;
  const listeners: Array<(e: unknown) => void> = [];
  const emit = (e: unknown) => {
    for (const l of [...listeners]) l(e);
  };
  const sessionManager = {
    appendCustomEntry: vi.fn((customType: string, data: unknown) => {
      const id = `e${nextId++}`;
      entries.push({ type: "custom", id, customType, data });
      return id;
    }),
    appendMessage: (message: unknown) => {
      const id = `e${nextId++}`;
      entries.push({ type: "message", id, message });
      return id;
    },
    getLeafEntry: () => entries[entries.length - 1],
    getEntries: () => entries,
  };

  let streaming = false;
  const queued: Array<{ text: string; behavior: "steer" | "followUp" }> = [];
  let openRunHook: ((prompt: string) => void) | null = null;
  /** Assistant text to stream per run; set by the test. */
  let assistantText = "ok";
  /** Resolve to let a run finish; the test controls pacing. */
  let releaseRun: (() => void) | null = null;

  const userMessage = (text: string) => ({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  });
  const deliverUser = (msg: unknown) => {
    emit({ type: "message_start", message: msg });
    emit({ type: "message_end", message: msg });
    sessionManager.appendMessage(msg);
  };

  const session = {
    subscribe: (cb: (e: unknown) => void) => {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i !== -1) listeners.splice(i, 1);
      };
    },
    get isStreaming() {
      return streaming;
    },
    prompt: vi.fn(async (text: string, opts?: { streamingBehavior?: "steer" | "followUp" }) => {
      if (streaming) {
        if (!opts?.streamingBehavior) {
          throw new Error(
            "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."
          );
        }
        queued.push({ text, behavior: opts.streamingBehavior });
        return;
      }
      openRunHook?.(text);
      streaming = true;
      const msg = userMessage(text);
      emit({ type: "agent_start" });
      emit({ type: "turn_start" });
      deliverUser(msg);
      // Assistant turn; the test decides when it ends.
      await new Promise<void>((res) => (releaseRun = res));
      const asst = { role: "assistant", content: [{ type: "text", text: assistantText }] };
      emit({ type: "message_start", message: asst });
      emit({ type: "message_end", message: asst });
      sessionManager.appendMessage(asst);
      // Deliver queued messages inside the same run (pi's outer loop).
      while (queued.length) {
        const q = queued.shift()!;
        emit({ type: "turn_start" });
        deliverUser(userMessage(q.text));
        const a2 = { role: "assistant", content: [{ type: "text", text: `re: ${q.text}` }] };
        emit({ type: "message_start", message: a2 });
        emit({ type: "message_end", message: a2 });
        sessionManager.appendMessage(a2);
      }
      streaming = false;
      emit({ type: "agent_end", messages: [] });
    }),
    sessionManager,
  };

  return {
    session: session as unknown as TrackerSession,
    entries,
    setOpenRunHook: (h: (prompt: string) => void) => (openRunHook = h),
    finishRun: async () => {
      // Let the microtask that persists den.origin run first.
      await Promise.resolve();
      releaseRun?.();
      releaseRun = null;
      await new Promise((r) => setTimeout(r, 0));
    },
    setAssistantText: (t: string) => (assistantText = t),
    /** Emit a raw session event, for sequences prompt() does not produce. */
    emit,
    /** Simulate a slash command pi handled with no user message. */
    promptAsCommand: () => {
      session.prompt.mockImplementationOnce(async () => {});
    },
  };
}

function customEntries(entries: Array<{ type: string; customType?: string; data?: unknown }>, type: string) {
  return entries.filter((e) => e.type === "custom" && e.customType === type).map((e) => e.data as any);
}

describe("ProvenanceTracker", () => {
  it("attributes the opening message, writes den.run and den.origin, and closes the run", async () => {
    const f = fakeSession();
    const tracker = new ProvenanceTracker(f.session);
    f.setOpenRunHook((p) => tracker.openRun(p));
    const events: ProvenanceEvent[] = [];
    tracker.subscribe((e) => events.push(e));

    const o = origin("alpha", { kind: "human", id: "operator" }, "alpha-1");
    const p = tracker.dispatch("[alpha] hello", o, { streamingBehavior: "followUp" });
    await Promise.resolve();

    // Run opened with alpha as owner, before agent_start.
    expect(events[0]).toMatchObject({ type: "run_start", run: { owner: o, origins: [o] } });
    expect(tracker.isOwnedBy("alpha")).toBe(true);
    expect(tracker.isOwnedBy("beta")).toBe(false);

    await f.finishRun();
    await p;

    const runs = customEntries(f.entries, RUN_ENTRY_TYPE);
    expect(runs).toHaveLength(1);
    expect(runs[0].owner).toEqual(o);

    const origins = customEntries(f.entries, ORIGIN_ENTRY_TYPE);
    expect(origins).toHaveLength(1);
    expect(origins[0].origin).toEqual(o);
    expect(origins[0].delivery).toBe("prompt");
    // `for` points at the persisted user message entry by id, and that
    // entry's message is the one pi delivered — identity, not text.
    const userEntry = f.entries.find((e) => e.id === origins[0].for)!;
    expect(userEntry.type).toBe("message");
    expect((userEntry.message as any).role).toBe("user");
    // den.origin is adjacent: written right after the user message.
    expect(f.entries.indexOf(userEntry) + 1).toBe(
      f.entries.findIndex((e) => e.customType === ORIGIN_ENTRY_TYPE)
    );

    const ends = customEntries(f.entries, RUN_END_ENTRY_TYPE);
    expect(ends).toHaveLength(1);
    expect(ends[0].origins).toEqual([o]);
    expect(events.map((e) => e.type)).toEqual(["run_start", "origin", "run_end"]);
    expect(tracker.currentRun()).toBeNull();
  });

  it("keeps the opening origin as owner and adds a followUp from another channel to origins", async () => {
    const f = fakeSession();
    const tracker = new ProvenanceTracker(f.session);
    f.setOpenRunHook((p) => tracker.openRun(p));
    const events: ProvenanceEvent[] = [];
    tracker.subscribe((e) => events.push(e));

    const alpha = origin("alpha", { kind: "human", id: "operator" }, "a-1");
    const beta = origin("beta", { kind: "human", id: "operator" }, "b-1");
    const p1 = tracker.dispatch("[alpha] count to ten", alpha, { streamingBehavior: "followUp" });
    await Promise.resolve();
    expect(f.session.isStreaming).toBe(true);

    // beta arrives mid-run: queued by pi, no before_agent_start.
    await tracker.dispatch("[beta] interrupting", beta, { streamingBehavior: "steer" });
    expect(tracker.currentRun()?.owner).toEqual(alpha);

    await f.finishRun();
    await p1;

    const origins = customEntries(f.entries, ORIGIN_ENTRY_TYPE);
    expect(origins.map((o: any) => [o.origin.channel, o.delivery])).toEqual([
      ["alpha", "prompt"],
      ["beta", "steer"],
    ]);
    const end = customEntries(f.entries, RUN_END_ENTRY_TYPE)[0];
    expect(end.origins.map((o: any) => o.channel)).toEqual(["alpha", "beta"]);
    // Owner never changed: the run stays alpha's even though beta spoke.
    const run = customEntries(f.entries, RUN_ENTRY_TYPE)[0];
    expect(run.owner.channel).toBe("alpha");
    expect(events.filter((e) => e.type === "run_start")).toHaveLength(1);
  });

  it("withdraws the record when prompt() throws, so it cannot attach to a later message", async () => {
    const f = fakeSession();
    const tracker = new ProvenanceTracker(f.session);
    f.setOpenRunHook((p) => tracker.openRun(p));

    const alpha = origin("alpha", { kind: "human" });
    const beta = origin("beta", { kind: "human" });
    const p1 = tracker.dispatch("[alpha] first", alpha, { streamingBehavior: "followUp" });
    await Promise.resolve();

    // No streamingBehavior while streaming: pi's "already processing".
    await expect(tracker.dispatch("[beta] oops", beta)).rejects.toThrow(/already processing/);

    await f.finishRun();
    await p1;

    // A later beta message with the same text must get its own, fresh origin.
    const beta2 = origin("beta", { kind: "human" }, "b-2");
    const p2 = tracker.dispatch("[beta] oops", beta2, { streamingBehavior: "followUp" });
    await Promise.resolve();
    await f.finishRun();
    await p2;

    const origins = customEntries(f.entries, ORIGIN_ENTRY_TYPE);
    expect(origins).toHaveLength(2);
    expect(origins[1].origin).toEqual(beta2);
  });

  it("withdraws the record when pi consumes the text as a command with no message", async () => {
    const f = fakeSession();
    const tracker = new ProvenanceTracker(f.session);
    f.setOpenRunHook((p) => tracker.openRun(p));
    f.promptAsCommand();
    await tracker.dispatch("/status", origin("alpha", { kind: "human" }));

    // Now a real message; it must not inherit the /status record.
    const alpha = origin("alpha", { kind: "human" }, "a-2");
    const p = tracker.dispatch("[alpha] hi", alpha, { streamingBehavior: "followUp" });
    await Promise.resolve();
    await f.finishRun();
    await p;
    const origins = customEntries(f.entries, ORIGIN_ENTRY_TYPE);
    expect(origins).toHaveLength(1);
    expect(origins[0].origin.ref).toBe("a-2");
  });

  it("opens an ownerless run when agent_start arrives without before_agent_start", async () => {
    const f = fakeSession();
    const tracker = new ProvenanceTracker(f.session);
    // No openRun hook: the extension is absent, or this is a continue loop.
    const events: ProvenanceEvent[] = [];
    tracker.subscribe((e) => events.push(e));
    const p = f.session.prompt("[nobody] raw", { streamingBehavior: "followUp" });
    await Promise.resolve();
    expect(tracker.currentRun()?.owner).toBeNull();
    await f.finishRun();
    await p;
    expect(customEntries(f.entries, RUN_ENTRY_TYPE)[0].owner).toBeNull();
    // Unattributed message: no den.origin written, no origin event.
    expect(customEntries(f.entries, ORIGIN_ENTRY_TYPE)).toHaveLength(0);
    expect(events.map((e) => e.type)).toEqual(["run_start", "run_end"]);
  });

  describe("a run pi retries after a failed model call", () => {
    const DEN = () => origin("workspace", { kind: "human", id: "sam" }, "ref-1");
    /** One owned run that ends, as pi ends a run whose model call errored. */
    const failedRun = async (f: ReturnType<typeof fakeSession>, tracker: ProvenanceTracker) => {
      f.setOpenRunHook((text) => tracker.openRun(text));
      const p = tracker.dispatch("say it aloud", DEN());
      await f.finishRun();
      await p;
    };
    const retryRun = (f: ReturnType<typeof fakeSession>) => {
      f.emit({ type: "agent_start" });
      f.emit({ type: "turn_start" });
    };

    it("keeps the owner of the run that failed, whether pi announces the retry after the run ends or before", async () => {
      // After agent_end.
      const f = fakeSession();
      const tracker = new ProvenanceTracker(f.session);
      await failedRun(f, tracker);
      expect(tracker.currentRun()).toBeNull();
      f.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "stream dropped" });
      retryRun(f);
      expect(tracker.currentRun()?.owner).toMatchObject({ channel: "workspace", actor: { id: "sam" } });
      expect(tracker.isOwnedBy("workspace")).toBe(true);
      const runs = customEntries(f.entries, RUN_ENTRY_TYPE);
      expect(runs).toHaveLength(2);
      expect(runs[1].owner).toMatchObject({ channel: "workspace" });
      expect(runs[1].origins).toHaveLength(1);
      expect(runs[1].id).not.toBe(runs[0].id);

      // Before agent_end: announced while the failing run is still open.
      const g = fakeSession();
      const t2 = new ProvenanceTracker(g.session);
      g.setOpenRunHook((text) => t2.openRun(text));
      const p = t2.dispatch("say it aloud", DEN());
      await Promise.resolve();
      g.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "stream dropped" });
      await g.finishRun();
      await p;
      retryRun(g);
      expect(t2.currentRun()?.owner).toMatchObject({ channel: "workspace" });
    });

    it("only the retry inherits: the run after it is ownerless again", async () => {
      const f = fakeSession();
      const tracker = new ProvenanceTracker(f.session);
      await failedRun(f, tracker);
      f.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 0, errorMessage: "x" });
      retryRun(f);
      f.emit({ type: "agent_end", messages: [] });
      f.emit({ type: "auto_retry_end", success: true, attempt: 1 });
      retryRun(f);
      expect(tracker.currentRun()?.owner).toBeNull();
    });

    it("nothing inherits when pi gives up, or when a new prompt arrives first", async () => {
      const f = fakeSession();
      const tracker = new ProvenanceTracker(f.session);
      await failedRun(f, tracker);
      f.emit({ type: "auto_retry_start", attempt: 3, maxAttempts: 3, delayMs: 0, errorMessage: "x" });
      f.emit({ type: "auto_retry_end", success: false, attempt: 3 });
      retryRun(f);
      expect(tracker.currentRun()?.owner).toBeNull();
      f.emit({ type: "agent_end", messages: [] });

      // A new prompt from someone else between the announcement and any retry.
      const g = fakeSession();
      const t2 = new ProvenanceTracker(g.session);
      await failedRun(g, t2);
      g.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 0, errorMessage: "x" });
      const p = t2.dispatch("hello", origin("telegram", { kind: "human", id: "kim" }));
      await Promise.resolve();
      expect(t2.currentRun()?.owner).toMatchObject({ channel: "telegram" });
      await g.finishRun();
      await p;
      retryRun(g);
      expect(t2.currentRun()?.owner).toBeNull();
    });

    it("an ownerless start with no retry announced is still ownerless, even right after an owned run", async () => {
      const f = fakeSession();
      const tracker = new ProvenanceTracker(f.session);
      await failedRun(f, tracker);
      retryRun(f);
      expect(tracker.currentRun()?.owner).toBeNull();
    });
  });

  it("ownsSessionManager identifies the tracked session by identity", () => {
    const f = fakeSession();
    const tracker = new ProvenanceTracker(f.session);
    expect(tracker.ownsSessionManager(f.session.sessionManager)).toBe(true);
    expect(tracker.ownsSessionManager({})).toBe(false);
  });
});

describe("ProvenanceTracker.expect (input catch-all)", () => {
  it("attributes a message someone else hands to pi, without sending it", async () => {
    const f = fakeSession();
    const tracker = new ProvenanceTracker(f.session);
    f.setOpenRunHook((p) => tracker.openRun(p));
    const coarse = origin("extension", { kind: "system", id: "pi.sendUserMessage" });
    expect(tracker.hasPending("[inner thought] hi")).toBe(false);
    tracker.expect("[inner thought] hi", coarse, "followUp");
    expect(tracker.hasPending("[inner thought] hi")).toBe(true);
    // The extension calls pi directly; the tracker never saw a dispatch.
    const p = f.session.prompt("[inner thought] hi", { streamingBehavior: "followUp" });
    await Promise.resolve();
    expect(tracker.currentRun()?.owner).toEqual(coarse);
    await f.finishRun();
    await p;
    const origins = customEntries(f.entries, ORIGIN_ENTRY_TYPE);
    expect(origins).toHaveLength(1);
    expect(origins[0].origin.actor.id).toBe("pi.sendUserMessage");
    expect(origins[0].delivery).toBe("prompt");
    expect(tracker.hasPending("[inner thought] hi")).toBe(false);
  });
});
