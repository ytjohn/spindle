import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MemoryEngine } from "../../src/memory/engine";
import {
  runDaydreamCycle,
  type EphemeralSession,
  type EphemeralSessionFactory,
} from "../../src/daydream/cycle";

let tmpDir: string;
let dbPath: string;
let sessionFile: string;
let engine: MemoryEngine;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "spindle-dd-cycle-"));
  dbPath = join(tmpDir, "memory.db");
  sessionFile = join(tmpDir, "session.jsonl");
  engine = await MemoryEngine.open({ database_path: dbPath });
  engine.registerAgent("eliza", "Eliza");
});

afterEach(() => {
  engine.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// Test helpers
// ============================================================================

/** Write a minimal pi session JSONL fixture. */
function writeSessionFixture(
  messages: Array<{
    role: "user" | "assistant" | "toolResult";
    timestamp: string;
    text: string;
  }>
): void {
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "fixture-sess",
      timestamp: messages[0]?.timestamp ?? "2026-04-12T10:00:00.000Z",
      cwd: "/test",
    }),
  ];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    lines.push(
      JSON.stringify({
        type: "message",
        id: `msg-${i}`,
        parentId: i === 0 ? null : `msg-${i - 1}`,
        timestamp: m.timestamp,
        message: { role: m.role, content: [{ type: "text", text: m.text }] },
      })
    );
  }
  writeFileSync(sessionFile, lines.join("\n") + "\n");
}

/**
 * Build a mock ephemeral session that fires synthetic tool events and
 * a message_end event when `prompt()` is called. The test controls
 * which tool calls fire via the `storeCount` / `toolNames` options.
 */
interface MockSessionOptions {
  /** How many spindle_memory_store calls to simulate. */
  storeCount?: number;
  /** Additional tool names to fire (non-memory_store). */
  otherTools?: string[];
  /** Have the session emit an error message at the end. */
  errorMessage?: string;
  /** Have prompt() throw synchronously. */
  throwOnPrompt?: Error;
  /** Have prompt() resolve without firing message_end (tests the hang-safeguard). */
  skipMessageEnd?: boolean;
  /** Simulated tool errors (memory_store calls that are flagged isError=true). */
  erroredStoreCount?: number;
}

function makeMockSession(opts: MockSessionOptions = {}): {
  session: EphemeralSession;
  promptCalls: string[];
  closed: boolean;
} {
  const subscribers: Array<(event: unknown) => void> = [];
  const promptCalls: string[] = [];
  let closed = false;

  const emit = (event: unknown) => {
    for (const cb of [...subscribers]) cb(event);
  };

  const session: EphemeralSession = {
    async prompt(text: string) {
      promptCalls.push(text);
      if (opts.throwOnPrompt) throw opts.throwOnPrompt;

      // Fire tool execution events for each successful memory_store call
      for (let i = 0; i < (opts.storeCount ?? 0); i++) {
        emit({
          type: "tool_execution_end",
          toolCallId: `call-${i}`,
          toolName: "spindle_memory_store",
          result: { id: i + 1 },
          isError: false,
        });
      }
      // Errored memory_store calls (should NOT count toward stored)
      for (let i = 0; i < (opts.erroredStoreCount ?? 0); i++) {
        emit({
          type: "tool_execution_end",
          toolCallId: `err-${i}`,
          toolName: "spindle_memory_store",
          result: { error: "boom" },
          isError: true,
        });
      }
      // Additional non-memory tool calls (should NOT count)
      for (const name of opts.otherTools ?? []) {
        emit({
          type: "tool_execution_end",
          toolCallId: `other-${name}`,
          toolName: name,
          result: {},
          isError: false,
        });
      }

      if (opts.skipMessageEnd) {
        // Don't emit message_end / agent_end — the cycle should detect the hang
        return;
      }

      // Emit message_end followed by agent_end. The cycle only resolves
      // on agent_end (pi's terminal event for a completed agent loop) —
      // see the matching comment in cycle.ts. The mock mirrors pi's
      // real event order: assistant message_end first, then tool events
      // are fired earlier in prompt(), then agent_end closes the loop.
      const msg = opts.errorMessage ? { errorMessage: opts.errorMessage } : {};
      emit({ type: "message_end", message: msg });
      emit({ type: "agent_end", messages: [] });
    },
    subscribe(callback) {
      subscribers.push(callback);
      return () => {
        const idx = subscribers.indexOf(callback);
        if (idx !== -1) subscribers.splice(idx, 1);
      };
    },
    async close() {
      closed = true;
    },
  };

  return {
    session,
    promptCalls,
    get closed() {
      return closed;
    },
  };
}

function makeFactory(opts: MockSessionOptions = {}): {
  factory: EphemeralSessionFactory;
  getSession: () => ReturnType<typeof makeMockSession> | null;
} {
  let built: ReturnType<typeof makeMockSession> | null = null;
  const factory: EphemeralSessionFactory = async () => {
    built = makeMockSession(opts);
    return built.session;
  };
  return { factory, getSession: () => built };
}

// ============================================================================
// Cycle tests
// ============================================================================

describe("runDaydreamCycle", () => {
  it("skips when the session file doesn't exist", async () => {
    const { factory } = makeFactory();
    const result = await runDaydreamCycle({
      engine,
      agentId: "eliza",
      sessionFile: join(tmpDir, "does-not-exist.jsonl"),
      watermark: 0,
      config: {},
      sessionFactory: factory,
    });
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toMatch(/below_min_turns/);
    expect(result.stored).toBe(0);
  });

  it("skips when activity is below min_turns_since_last", async () => {
    writeSessionFixture([
      { role: "user", timestamp: "2026-04-12T10:00:00.000Z", text: "hi" },
    ]);
    const { factory } = makeFactory();
    const result = await runDaydreamCycle({
      engine,
      agentId: "eliza",
      sessionFile,
      watermark: 0,
      config: { min_turns_since_last: 2 },
      sessionFactory: factory,
    });
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toMatch(/below_min_turns/);
  });

  it("skips when activity is below the default min_turns (2)", async () => {
    writeSessionFixture([
      { role: "user", timestamp: "2026-04-12T10:00:00.000Z", text: "only one turn" },
    ]);
    const { factory } = makeFactory();
    const result = await runDaydreamCycle({
      engine,
      agentId: "eliza",
      sessionFile,
      watermark: 0,
      config: {},
      sessionFactory: factory,
    });
    expect(result.skipped).toBe(true);
  });

  it("tool result turns do NOT count toward min_turns", async () => {
    writeSessionFixture([
      { role: "user", timestamp: "2026-04-12T10:00:00.000Z", text: "hi" },
      { role: "toolResult", timestamp: "2026-04-12T10:00:01.000Z", text: "tool out" },
    ]);
    const { factory } = makeFactory();
    const result = await runDaydreamCycle({
      engine,
      agentId: "eliza",
      sessionFile,
      watermark: 0,
      config: { min_turns_since_last: 2 },
      sessionFactory: factory,
    });
    // 1 user + 1 toolResult = only 1 conversational, below 2
    expect(result.skipped).toBe(true);
  });

  it("runs a happy path cycle and reports stored count from tool events", async () => {
    writeSessionFixture([
      { role: "user", timestamp: "2026-04-12T10:00:00.000Z", text: "my cat is Pixel" },
      { role: "assistant", timestamp: "2026-04-12T10:00:05.000Z", text: "got it" },
      { role: "user", timestamp: "2026-04-12T10:00:10.000Z", text: "I live in PGH" },
    ]);
    const { factory, getSession } = makeFactory({ storeCount: 3 });
    const result = await runDaydreamCycle({
      engine,
      agentId: "eliza",
      sessionFile,
      watermark: 0,
      config: {},
      sessionFactory: factory,
    });
    expect(result.skipped).toBe(false);
    expect(result.errored).toBe(false);
    expect(result.stored).toBe(3);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    // The mock session should have been prompted once with the user prompt
    const session = getSession();
    expect(session?.promptCalls).toHaveLength(1);
    expect(session?.promptCalls[0]).toMatch(/review the recent activity/);
  });

  it("errored memory_store tool calls do not count toward stored", async () => {
    writeSessionFixture([
      { role: "user", timestamp: "2026-04-12T10:00:00.000Z", text: "hello" },
      { role: "assistant", timestamp: "2026-04-12T10:00:01.000Z", text: "hi" },
    ]);
    const { factory } = makeFactory({ storeCount: 2, erroredStoreCount: 1 });
    const result = await runDaydreamCycle({
      engine,
      agentId: "eliza",
      sessionFile,
      watermark: 0,
      config: {},
      sessionFactory: factory,
    });
    expect(result.stored).toBe(2);
  });

  it("other tool calls (not memory_store) do not count toward stored", async () => {
    writeSessionFixture([
      { role: "user", timestamp: "2026-04-12T10:00:00.000Z", text: "hello" },
      { role: "assistant", timestamp: "2026-04-12T10:00:01.000Z", text: "hi" },
    ]);
    const { factory } = makeFactory({
      storeCount: 1,
      otherTools: ["spindle_memory_recall", "bash", "read"],
    });
    const result = await runDaydreamCycle({
      engine,
      agentId: "eliza",
      sessionFile,
      watermark: 0,
      config: {},
      sessionFactory: factory,
    });
    expect(result.stored).toBe(1);
  });

  it("returns skipped with session_create_failed when factory throws", async () => {
    writeSessionFixture([
      { role: "user", timestamp: "2026-04-12T10:00:00.000Z", text: "a" },
      { role: "assistant", timestamp: "2026-04-12T10:00:01.000Z", text: "b" },
    ]);
    const factory: EphemeralSessionFactory = async () => {
      throw new Error("no provider configured");
    };
    const result = await runDaydreamCycle({
      engine,
      agentId: "eliza",
      sessionFile,
      watermark: 0,
      config: {},
      sessionFactory: factory,
    });
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("session_create_failed");
    expect(result.errorMessage).toMatch(/no provider/);
    expect(result.stored).toBe(0);
  });

  it("returns errored when session.prompt rejects", async () => {
    writeSessionFixture([
      { role: "user", timestamp: "2026-04-12T10:00:00.000Z", text: "a" },
      { role: "assistant", timestamp: "2026-04-12T10:00:01.000Z", text: "b" },
    ]);
    const { factory } = makeFactory({ throwOnPrompt: new Error("vllm 500") });
    const result = await runDaydreamCycle({
      engine,
      agentId: "eliza",
      sessionFile,
      watermark: 0,
      config: {},
      sessionFactory: factory,
    });
    expect(result.errored).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.errorMessage).toMatch(/vllm 500/);
  });

  it("returns errored when message_end carries an errorMessage", async () => {
    writeSessionFixture([
      { role: "user", timestamp: "2026-04-12T10:00:00.000Z", text: "a" },
      { role: "assistant", timestamp: "2026-04-12T10:00:01.000Z", text: "b" },
    ]);
    const { factory } = makeFactory({ errorMessage: "context overflow" });
    const result = await runDaydreamCycle({
      engine,
      agentId: "eliza",
      sessionFile,
      watermark: 0,
      config: {},
      sessionFactory: factory,
    });
    expect(result.errored).toBe(true);
    expect(result.errorMessage).toMatch(/context overflow/);
  });

  it("watermark filters out earlier activity", async () => {
    writeSessionFixture([
      { role: "user", timestamp: "2026-04-12T09:00:00.000Z", text: "old 1" },
      { role: "assistant", timestamp: "2026-04-12T09:00:01.000Z", text: "old 2" },
      { role: "user", timestamp: "2026-04-12T09:00:02.000Z", text: "old 3" },
    ]);
    const watermark = Date.parse("2026-04-12T10:00:00.000Z"); // after all entries
    const { factory } = makeFactory();
    const result = await runDaydreamCycle({
      engine,
      agentId: "eliza",
      sessionFile,
      watermark,
      config: { min_turns_since_last: 2 },
      sessionFactory: factory,
    });
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toMatch(/below_min_turns/);
  });

  it("pulls existing memories into the dedup context", async () => {
    writeSessionFixture([
      { role: "user", timestamp: "2026-04-12T10:00:00.000Z", text: "a" },
      { role: "assistant", timestamp: "2026-04-12T10:00:01.000Z", text: "b" },
    ]);
    await engine.store("eliza", { content: "user's cat is named Pixel" });
    await engine.store("eliza", { content: "user prefers short responses" });

    // The factory receives the built prompt — we can peek at it to
    // verify existing memories were included.
    let capturedPrompt: { systemPrompt: string; userPrompt: string } | null = null;
    const factory: EphemeralSessionFactory = async (prompt) => {
      capturedPrompt = prompt;
      return makeMockSession({ storeCount: 0 }).session;
    };

    await runDaydreamCycle({
      engine,
      agentId: "eliza",
      sessionFile,
      watermark: 0,
      config: {},
      sessionFactory: factory,
    });

    expect(capturedPrompt).not.toBeNull();
    expect(capturedPrompt!.systemPrompt).toContain("Pixel");
    expect(capturedPrompt!.systemPrompt).toContain("short responses");
  });

  it("always closes the session even on error", async () => {
    writeSessionFixture([
      { role: "user", timestamp: "2026-04-12T10:00:00.000Z", text: "a" },
      { role: "assistant", timestamp: "2026-04-12T10:00:01.000Z", text: "b" },
    ]);
    const { factory, getSession } = makeFactory({
      throwOnPrompt: new Error("boom"),
    });
    await runDaydreamCycle({
      engine,
      agentId: "eliza",
      sessionFile,
      watermark: 0,
      config: {},
      sessionFactory: factory,
    });
    expect(getSession()?.closed).toBe(true);
  });

  it("always closes the session on happy path", async () => {
    writeSessionFixture([
      { role: "user", timestamp: "2026-04-12T10:00:00.000Z", text: "a" },
      { role: "assistant", timestamp: "2026-04-12T10:00:01.000Z", text: "b" },
    ]);
    const { factory, getSession } = makeFactory({ storeCount: 1 });
    await runDaydreamCycle({
      engine,
      agentId: "eliza",
      sessionFile,
      watermark: 0,
      config: {},
      sessionFactory: factory,
    });
    expect(getSession()?.closed).toBe(true);
  });

  it("respects max_store_per_cycle — reflected in the prompt, enforced by the LLM", async () => {
    // The cycle doesn't enforce max_store itself — it just injects it
    // into the prompt. This test verifies the config flows into the
    // prompt; the LLM's obedience is up to the LLM.
    writeSessionFixture([
      { role: "user", timestamp: "2026-04-12T10:00:00.000Z", text: "a" },
      { role: "assistant", timestamp: "2026-04-12T10:00:01.000Z", text: "b" },
    ]);
    let captured: { systemPrompt: string } | null = null;
    const factory: EphemeralSessionFactory = async (prompt) => {
      captured = prompt;
      return makeMockSession({ storeCount: 0 }).session;
    };
    await runDaydreamCycle({
      engine,
      agentId: "eliza",
      sessionFile,
      watermark: 0,
      config: { max_store_per_cycle: 3 },
      sessionFactory: factory,
    });
    expect(captured!.systemPrompt).toContain("AT MOST 3");
  });

  it("uses injected now function for deterministic cycle timing", async () => {
    writeSessionFixture([
      { role: "user", timestamp: "2026-04-12T10:00:00.000Z", text: "a" },
      { role: "assistant", timestamp: "2026-04-12T10:00:01.000Z", text: "b" },
    ]);
    const fixedNow = Date.parse("2026-04-12T11:00:00.000Z");
    const { factory } = makeFactory({ storeCount: 0 });
    const result = await runDaydreamCycle({
      engine,
      agentId: "eliza",
      sessionFile,
      watermark: 0,
      config: {},
      sessionFactory: factory,
      now: () => fixedNow,
    });
    expect(result.startedAt).toBe(fixedNow);
  });

  // Regression for the Phase 5 smoke-test bug: pi's agent loop emits
  // message_end for the user prompt's OWN message BEFORE running the
  // LLM (see pi-agent-core/dist/agent-loop.js ~line 52). The cycle's
  // old event handler unsubscribed on the first message_end, resolving
  // endPromise before tool_execution events could arrive — so stored
  // always came back 0 even though the extension's execute handler
  // ran in the engine and rows did land in SQLite.
  //
  // Fix: wait for agent_end (the true terminal event) instead. This
  // test replicates pi's real event order to guarantee we never
  // regress to the early-unsubscribe behavior.
  it("counts tool events that arrive AFTER message_end (pi's real event order)", async () => {
    writeSessionFixture([
      { role: "user", timestamp: "2026-04-12T10:00:00.000Z", text: "my cat is Mochi" },
      { role: "assistant", timestamp: "2026-04-12T10:00:01.000Z", text: "got it" },
    ]);

    // Hand-built mock that interleaves events in pi's real order:
    //   1. message_end for the user prompt (fires BEFORE the LLM runs)
    //   2. message_start/message_end for the assistant message
    //   3. tool_execution_start/end for each tool call in that message
    //   4. message_start/end for the tool result message
    //   5. agent_end (terminal)
    const factory: EphemeralSessionFactory = async () => {
      const subs: Array<(e: unknown) => void> = [];
      return {
        async prompt() {
          const emit = (e: unknown) => {
            for (const cb of [...subs]) cb(e);
          };
          // (1) User prompt message_end — old code would unsubscribe here
          emit({ type: "message_start", message: { role: "user" } });
          emit({ type: "message_end", message: { role: "user" } });
          // (2) Assistant message containing tool calls
          emit({ type: "message_start", message: { role: "assistant" } });
          emit({ type: "message_end", message: { role: "assistant" } });
          // (3) Tool executions — these fire AFTER the assistant message
          //     is "ended" because pi's loop runs the tools in a
          //     separate step once the message is complete.
          emit({
            type: "tool_execution_start",
            toolCallId: "c1",
            toolName: "spindle_memory_store",
            args: {},
          });
          emit({
            type: "tool_execution_end",
            toolCallId: "c1",
            toolName: "spindle_memory_store",
            result: { id: 1 },
            isError: false,
          });
          emit({
            type: "tool_execution_start",
            toolCallId: "c2",
            toolName: "spindle_memory_store",
            args: {},
          });
          emit({
            type: "tool_execution_end",
            toolCallId: "c2",
            toolName: "spindle_memory_store",
            result: { id: 2 },
            isError: false,
          });
          // (4) Tool result message
          emit({ type: "message_start", message: { role: "toolResult" } });
          emit({ type: "message_end", message: { role: "toolResult" } });
          // (5) Terminal agent_end
          emit({ type: "agent_end", messages: [] });
        },
        subscribe(cb) {
          subs.push(cb);
          return () => {
            const idx = subs.indexOf(cb);
            if (idx !== -1) subs.splice(idx, 1);
          };
        },
        async close() {},
      };
    };

    const result = await runDaydreamCycle({
      engine,
      agentId: "eliza",
      sessionFile,
      watermark: 0,
      config: {},
      sessionFactory: factory,
    });

    expect(result.skipped).toBe(false);
    expect(result.errored).toBe(false);
    // Both tool executions counted even though they arrived AFTER the
    // first message_end. If this drops to 0, the cycle regressed to
    // unsubscribing on message_end instead of agent_end.
    expect(result.stored).toBe(2);
  });
});
