import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "bun:sqlite";
import { applyPragmas, runMigrations } from "../../src/memory/schema";
import { CompactNudgeRunner } from "../../src/compact/runner";
import {
  bindTelemetryRecorder,
  resetTelemetryBinding,
} from "../../src/telemetry/binding";
import { ContextTelemetryRecorder } from "../../src/telemetry/recorder";
import { listRecentCompactEvents } from "../../src/telemetry/store";
import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionEventListener,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Fake session factory — reuses the same narrow-surface pattern as
// tests/telemetry/recorder.test.ts so tests stay structurally consistent.
// ---------------------------------------------------------------------------

interface FakeSessionOpts {
  contextPercent?: number | null;
  contextTokens?: number | null;
  contextWindow?: number;
  isCompacting?: boolean;
  isStreaming?: boolean;
  compactResult?: { tokensBefore: number; summary: string; firstKeptEntryId: string };
  compactThrows?: boolean;
}

function makeFakeSession(opts: FakeSessionOpts = {}): {
  session: AgentSession;
  emit: (event: AgentSessionEvent) => void;
  compactCalls: string[];
} {
  const subscribers: AgentSessionEventListener[] = [];
  const compactCalls: string[] = [];

  const fake: Record<string, unknown> = {
    isCompacting: opts.isCompacting ?? false,
    isStreaming: opts.isStreaming ?? false,

    subscribe(fn: AgentSessionEventListener) {
      subscribers.push(fn);
      return () => {
        const idx = subscribers.indexOf(fn);
        if (idx !== -1) subscribers.splice(idx, 1);
      };
    },

    getContextUsage() {
      if (opts.contextPercent === undefined && opts.contextTokens === undefined) {
        return undefined;
      }
      return {
        tokens: opts.contextTokens ?? null,
        percent: opts.contextPercent ?? null,
        contextWindow: opts.contextWindow ?? 118000,
      };
    },

    getSessionStats() {
      return {
        sessionId: "test-session",
        sessionFile: "/tmp/test.jsonl",
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
    },

    async compact(instructions?: string) {
      compactCalls.push(instructions ?? "");
      if (opts.compactThrows) throw new Error("compact failed");
      return opts.compactResult ?? { tokensBefore: 50000, summary: "summary", firstKeptEntryId: "id1" };
    },
  };

  return {
    session: fake as unknown as AgentSession,
    emit: (event) => {
      for (const s of [...subscribers]) s(event);
    },
    compactCalls,
  };
}

function agentEndEvent(): Extract<AgentSessionEvent, { type: "agent_end" }> {
  return { type: "agent_end" } as Extract<AgentSessionEvent, { type: "agent_end" }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): Database {
  const db = new Database(":memory:");
  applyPragmas(db);
  runMigrations(db);
  return db;
}

/** Wait for any pending microtasks (queueMicrotask deferral). */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CompactNudgeRunner", () => {
  beforeEach(() => {
    resetTelemetryBinding();
  });

  afterEach(() => {
    resetTelemetryBinding();
  });

  it("fires compact when percent crosses threshold", async () => {
    const { session, emit, compactCalls } = makeFakeSession({
      contextPercent: 75,
      contextTokens: 88500,
    });

    const runner = new CompactNudgeRunner({
      session,
      agentId: "test-agent",
      thresholdPercent: 70,
    });
    runner.start();

    emit(agentEndEvent());
    await flushMicrotasks();

    expect(compactCalls).toHaveLength(1);
    runner.stop();
  });

  it("skips compact when percent is below threshold", async () => {
    const { session, emit, compactCalls } = makeFakeSession({
      contextPercent: 65,
      contextTokens: 76700,
    });

    const runner = new CompactNudgeRunner({
      session,
      agentId: "test-agent",
      thresholdPercent: 70,
    });
    runner.start();

    emit(agentEndEvent());
    await flushMicrotasks();

    expect(compactCalls).toHaveLength(0);
    runner.stop();
  });

  // ── Regression: the "wedged agent" gap ─────────────────
  //
  // When a session has compacted once and every assistant message AFTER that
  // compaction boundary errored (stopReason === "error"/"aborted"), pi's
  // getContextUsage() returns { tokens: null, percent: null } because it has no
  // trustworthy post-compaction provider usage. The nudge runner is the SOLE
  // compaction driver when auto_toggle_pi_native=false, and it has no
  // estimate-from-messages fallback — so it skips (null_percent) while the real
  // (estimated) context keeps climbing. One agent reached 87,603 tokens
  // with no compaction this way.
  it("WEDGE: skips (no compaction) when usage is null after an errored turn, even past threshold", async () => {
    const { session, emit, compactCalls } = makeFakeSession({
      // Simulate getContextUsage() after a wedge: provider usage unavailable.
      contextTokens: null,
      contextPercent: null,
      contextWindow: 118000,
    });

    const runner = new CompactNudgeRunner({
      session,
      agentId: "test-agent",
      thresholdPercent: 70,
      // Even an absolute context_limit guard cannot help: tokens is null.
      contextLimit: 78000,
    });
    runner.start();

    emit(agentEndEvent());
    await flushMicrotasks();

    // Reproduction: no compaction fires despite the agent being over threshold
    // in reality. The runner is blind because usage.tokens === null.
    expect(compactCalls).toHaveLength(0);
    runner.stop();
  });

  it("skips when session.isCompacting is true", async () => {
    const { session, emit, compactCalls } = makeFakeSession({
      contextPercent: 80,
      isCompacting: true,
    });

    const runner = new CompactNudgeRunner({
      session,
      agentId: "test-agent",
      thresholdPercent: 70,
    });
    runner.start();

    emit(agentEndEvent());
    await flushMicrotasks();

    expect(compactCalls).toHaveLength(0);
    runner.stop();
  });

  it("fires even when session.isStreaming is true (pi clears it after agent_end)", async () => {
    // pi's isStreaming flag is still true when agent_end fires — pi clears
    // it on a later tick. Gating on it made the runner skip every turn,
    // so the guard was deliberately removed: agent_end is
    // itself the end-of-turn signal.
    const { session, emit, compactCalls } = makeFakeSession({
      contextPercent: 80,
      isStreaming: true,
    });

    const runner = new CompactNudgeRunner({
      session,
      agentId: "test-agent",
      thresholdPercent: 70,
    });
    runner.start();

    emit(agentEndEvent());
    await flushMicrotasks();

    expect(compactCalls).toHaveLength(1);
    runner.stop();
  });

  it("prevents re-entrancy while a compact is in-flight", async () => {
    let resolveCompact!: () => void;
    const compactCalls: number[] = [];

    const subscribers: AgentSessionEventListener[] = [];
    const fake: Record<string, unknown> = {
      isCompacting: false,
      isStreaming: false,
      subscribe(fn: AgentSessionEventListener) {
        subscribers.push(fn);
        return () => {
          const idx = subscribers.indexOf(fn);
          if (idx !== -1) subscribers.splice(idx, 1);
        };
      },
      getContextUsage() {
        return { tokens: 82600, percent: 70, contextWindow: 118000 };
      },
      getSessionStats() {
        return {
          sessionId: "test",
          sessionFile: "/tmp/test.jsonl",
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
      },
      async compact() {
        compactCalls.push(Date.now());
        await new Promise<void>((resolve) => { resolveCompact = resolve; });
        return { tokensBefore: 50000, summary: "s", firstKeptEntryId: "id" };
      },
    };

    const session = fake as unknown as AgentSession;
    const emit = (event: AgentSessionEvent) => {
      for (const s of [...subscribers]) s(event);
    };

    const runner = new CompactNudgeRunner({ session, agentId: "test-agent", thresholdPercent: 70 });
    runner.start();

    // First agent_end → compact starts (in flight)
    emit(agentEndEvent());
    await flushMicrotasks();
    expect(compactCalls).toHaveLength(1);

    // Second agent_end while compact is still in flight → must be ignored
    emit(agentEndEvent());
    await flushMicrotasks();
    expect(compactCalls).toHaveLength(1);

    // Let the first compact finish
    resolveCompact();
    await flushMicrotasks();

    runner.stop();
  });

  it("backs off after a failure within cooldown window", async () => {
    const { session, emit, compactCalls } = makeFakeSession({
      contextPercent: 80,
      compactThrows: true,
    });

    let fakeNow = 1000;
    const runner = new CompactNudgeRunner({
      session,
      agentId: "test-agent",
      thresholdPercent: 70,
      failureCooldownMs: 5000,
      now: () => fakeNow,
    });
    runner.start();

    // First attempt — should fail and record lastFailureAt
    emit(agentEndEvent());
    await flushMicrotasks();
    expect(compactCalls).toHaveLength(1);

    // Second attempt within cooldown (only +1 ms elapsed) — must be skipped
    fakeNow += 1;
    emit(agentEndEvent());
    await flushMicrotasks();
    expect(compactCalls).toHaveLength(1);

    // Third attempt after cooldown expires (+6000 ms total) — should fire
    fakeNow += 6000;
    emit(agentEndEvent());
    await flushMicrotasks();
    expect(compactCalls).toHaveLength(2);

    runner.stop();
  });

  it("caps instructions at 2000 chars (INSTRUCTIONS_CAP) before forwarding to compact()", async () => {
    const longInstructions = "x".repeat(2600);
    const { session, emit, compactCalls } = makeFakeSession({
      contextPercent: 75,
    });

    const runner = new CompactNudgeRunner({
      session,
      agentId: "test-agent",
      thresholdPercent: 70,
      instructions: longInstructions,
    });
    runner.start();

    emit(agentEndEvent());
    await flushMicrotasks();

    expect(compactCalls).toHaveLength(1);
    expect(compactCalls[0]).toHaveLength(2000);
    runner.stop();
  });

  it("stop() unsubscribes and prevents further compact calls", async () => {
    const { session, emit, compactCalls } = makeFakeSession({
      contextPercent: 75,
    });

    const runner = new CompactNudgeRunner({
      session,
      agentId: "test-agent",
      thresholdPercent: 70,
    });
    runner.start();
    runner.stop();

    emit(agentEndEvent());
    await flushMicrotasks();

    expect(compactCalls).toHaveLength(0);
  });

  it("records compact_events rows via telemetry binding when available", async () => {
    const db = makeDb();
    const subscribers: AgentSessionEventListener[] = [];

    const fakeSession = {
      isCompacting: false,
      isStreaming: false,
      subscribe(fn: AgentSessionEventListener) {
        subscribers.push(fn);
        return () => {
          const idx = subscribers.indexOf(fn);
          if (idx !== -1) subscribers.splice(idx, 1);
        };
      },
      getContextUsage: () => ({ tokens: 88500, percent: 75, contextWindow: 118000 }),
      getSessionStats: () => ({
        sessionId: "test-session",
        sessionFile: "/tmp/test.jsonl",
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      }),
      async compact() {
        return { tokensBefore: 88500, summary: "summary", firstKeptEntryId: "id1" };
      },
    };
    const session = fakeSession as unknown as AgentSession;

    const recorder = new ContextTelemetryRecorder({
      session,
      db,
      agentId: "test-agent",
    });
    recorder.start();
    bindTelemetryRecorder(recorder);

    const runner = new CompactNudgeRunner({
      session,
      agentId: "test-agent",
      thresholdPercent: 70,
    });
    runner.start();

    const emit = (event: AgentSessionEvent) => {
      for (const s of [...subscribers]) s(event);
    };

    emit(agentEndEvent());
    await flushMicrotasks();

    // Give the async runCompact a chance to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    const events = listRecentCompactEvents(db, "test-agent", 10);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const ev = events[0];
    expect(ev.trigger).toBe("nudge_threshold");
    expect(ev.tokens_before).toBe(88500);
    expect(ev.aborted).toBe(0);

    runner.stop();
    recorder.stop();
  });
});
