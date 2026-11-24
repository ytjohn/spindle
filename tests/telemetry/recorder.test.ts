import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "bun:sqlite";
import { applyPragmas, runMigrations } from "../../src/memory/schema";
import { ContextTelemetryRecorder } from "../../src/telemetry/recorder";
import {
  listRecentCompactEvents,
  listRecentContextStats,
} from "../../src/telemetry/store";
import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionEventListener,
} from "@earendil-works/pi-coding-agent";

/**
 * Minimal fake AgentSession — records the subscribe callback so tests
 * can emit events directly, and exposes getContextUsage + getSessionStats
 * returning canned values. Cast as AgentSession via `unknown` because
 * we only implement the narrow surface the recorder actually calls.
 */
function makeFakeSession(opts: {
  sessionId?: string;
  sessionFile?: string;
  tokens?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}): {
  session: AgentSession;
  emit: (event: AgentSessionEvent) => void;
  subscribers: AgentSessionEventListener[];
} {
  const subscribers: AgentSessionEventListener[] = [];
  const tokens = opts.tokens ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  };
  const sessionFile = opts.sessionFile ?? "/tmp/fake-session.jsonl";
  const sessionId = opts.sessionId ?? "fake-session-id";
  const fake = {
    subscribe(fn: AgentSessionEventListener) {
      subscribers.push(fn);
      return () => {
        const idx = subscribers.indexOf(fn);
        if (idx !== -1) subscribers.splice(idx, 1);
      };
    },
    getContextUsage() {
      return opts.contextUsage;
    },
    getSessionStats() {
      return {
        sessionId,
        sessionFile,
        userMessages: 0,
        assistantMessages: 0,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 0,
        tokens,
        cost: 0,
      };
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
    },
  };
  return {
    session: fake as unknown as AgentSession,
    emit: (event) => {
      // Iterate a snapshot so unsubscribe during dispatch is safe.
      for (const s of [...subscribers]) s(event);
    },
    subscribers,
  };
}

describe("ContextTelemetryRecorder", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyPragmas(db);
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("writes one context_stats row per agent_end", () => {
    const { session, emit } = makeFakeSession({
      sessionId: "s1",
      tokens: {
        input: 10_000,
        output: 500,
        cacheRead: 8_000,
        cacheWrite: 2_000,
        total: 10_500,
      },
      contextUsage: { tokens: 40_000, contextWindow: 128_000, percent: 31.25 },
    });
    let clock = 1_000;
    const rec = new ContextTelemetryRecorder({
      session,
      db,
      agentId: "casey",
      now: () => clock,
    });
    rec.start();

    // Simulate: user prompt → first assistant token → 2 tool calls → agent_end
    emit({
      type: "message_start",
      // The real shape has role on the message; stubbed here as unknown-cast.
      message: { role: "user" } as unknown as never,
    } as AgentSessionEvent);
    clock += 50;
    emit({
      type: "message_update",
      message: {} as unknown as never,
      assistantMessageEvent: { type: "text_delta", delta: "Hi" } as unknown as never,
    } as AgentSessionEvent);
    clock += 20;
    emit({
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "read",
      args: {},
    } as AgentSessionEvent);
    emit({
      type: "tool_execution_start",
      toolCallId: "t2",
      toolName: "bash",
      args: {},
    } as AgentSessionEvent);
    clock += 100;
    emit({
      type: "agent_end",
      messages: [],
    } as AgentSessionEvent);

    const rows = listRecentContextStats(db, "casey", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe("s1");
    expect(rows[0].turn_index).toBe(0);
    expect(rows[0].input_tokens).toBe(10_000);
    expect(rows[0].total_tokens).toBe(10_500);
    expect(rows[0].context_tokens).toBe(40_000);
    expect(rows[0].context_window).toBe(128_000);
    expect(rows[0].context_percent).toBeCloseTo(31.25, 2);
    expect(rows[0].tool_calls).toBe(2);
    // Timing: user prompt at 1000, agent_end at 1170 → 170 ms.
    expect(rows[0].ms_since_prompt).toBe(170);
    // First text_delta at 1050, agent_end at 1170 → 120 ms.
    expect(rows[0].ms_since_first_token).toBe(120);
    expect(rows[0].compacted_this_turn).toBe(0);
    expect(rows[0].compact_trigger).toBeNull();

    rec.stop();
  });

  it("increments turn_index across turns and resets accumulator", () => {
    const { session, emit } = makeFakeSession({});
    const rec = new ContextTelemetryRecorder({
      session,
      db,
      agentId: "a",
      now: () => 1,
    });
    rec.start();

    // First turn.
    emit({
      type: "message_start",
      message: { role: "user" } as unknown as never,
    } as AgentSessionEvent);
    emit({
      type: "tool_execution_start",
      toolCallId: "t",
      toolName: "x",
      args: {},
    } as AgentSessionEvent);
    emit({ type: "agent_end", messages: [] } as AgentSessionEvent);

    // Second turn — no tool calls. accumulator must have reset to 0.
    emit({
      type: "message_start",
      message: { role: "user" } as unknown as never,
    } as AgentSessionEvent);
    emit({ type: "agent_end", messages: [] } as AgentSessionEvent);

    const rows = listRecentContextStats(db, "a", 10);
    // Two rows, newest first.
    expect(rows).toHaveLength(2);
    expect(rows[0].turn_index).toBe(1);
    expect(rows[0].tool_calls).toBe(0);
    expect(rows[1].turn_index).toBe(0);
    expect(rows[1].tool_calls).toBe(1);
  });

  it("brackets pi compaction events into compact_events rows", () => {
    const { session, emit } = makeFakeSession({ sessionId: "s-auto" });
    let clock = 5_000;
    const rec = new ContextTelemetryRecorder({
      session,
      db,
      agentId: "a",
      now: () => clock,
    });
    rec.start();

    emit({
      type: "message_start",
      message: { role: "user" } as unknown as never,
    } as AgentSessionEvent);
    clock = 5_100;
    emit({
      type: "compaction_start",
      reason: "threshold",
    } as AgentSessionEvent);
    clock = 6_000;
    emit({
      type: "compaction_end",
      result: {
        summary: "sum",
        firstKeptEntryId: "x",
        tokensBefore: 42_000,
      } as unknown as never,
      aborted: false,
      willRetry: false,
    } as AgentSessionEvent);
    clock = 6_100;
    emit({ type: "agent_end", messages: [] } as AgentSessionEvent);

    const compactRows = listRecentCompactEvents(db, "a", 10);
    expect(compactRows).toHaveLength(1);
    expect(compactRows[0].trigger).toBe("pi_auto");
    expect(compactRows[0].reason).toBe("threshold");
    expect(compactRows[0].started_at).toBe(5_100);
    expect(compactRows[0].ended_at).toBe(6_000);
    expect(compactRows[0].tokens_before).toBe(42_000);
    expect(compactRows[0].aborted).toBe(0);

    const statRows = listRecentContextStats(db, "a", 10);
    expect(statRows).toHaveLength(1);
    expect(statRows[0].compacted_this_turn).toBe(1);
    expect(statRows[0].compact_trigger).toBe("pi_auto");
    expect(statRows[0].compact_tokens_before).toBe(42_000);

    rec.stop();
  });

  it("records aborted pi compaction correctly", () => {
    const { session, emit } = makeFakeSession({});
    const rec = new ContextTelemetryRecorder({
      session,
      db,
      agentId: "a",
      now: () => 1,
    });
    rec.start();
    emit({ type: "compaction_start", reason: "overflow" } as AgentSessionEvent);
    emit({
      type: "compaction_end",
      result: undefined,
      aborted: true,
      willRetry: false,
      errorMessage: "user cancelled",
    } as AgentSessionEvent);
    const rows = listRecentCompactEvents(db, "a", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].aborted).toBe(1);
    expect(rows[0].error).toBe("user cancelled");
    expect(rows[0].tokens_before).toBeNull();
    rec.stop();
  });

  it("recordExternalCompact brackets external compactions", () => {
    const { session } = makeFakeSession({});
    let clock = 100;
    const rec = new ContextTelemetryRecorder({
      session,
      db,
      agentId: "a",
      now: () => clock,
    });
    rec.start();
    const id = rec.recordExternalCompactStart("user_manual", {
      reason: "telegram /compact",
      instructionsSource: "static",
    });
    clock = 500;
    rec.recordExternalCompactEnd(id, {
      tokensBefore: 25_000,
      tokensAfter: 9_000,
    });
    const rows = listRecentCompactEvents(db, "a", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger).toBe("user_manual");
    expect(rows[0].reason).toBe("telegram /compact");
    expect(rows[0].instructions_source).toBe("static");
    expect(rows[0].started_at).toBe(100);
    expect(rows[0].ended_at).toBe(500);
    expect(rows[0].tokens_before).toBe(25_000);
    expect(rows[0].tokens_after).toBe(9_000);
    rec.stop();
  });

  it("stop() unsubscribes — further events have no effect", () => {
    const { session, emit, subscribers } = makeFakeSession({});
    const rec = new ContextTelemetryRecorder({
      session,
      db,
      agentId: "a",
      now: () => 1,
    });
    rec.start();
    expect(subscribers).toHaveLength(1);
    rec.stop();
    expect(subscribers).toHaveLength(0);
    emit({ type: "agent_end", messages: [] } as AgentSessionEvent);
    expect(listRecentContextStats(db, "a", 10)).toHaveLength(0);
  });

  it("errors in getContextUsage() do not crash the recorder", () => {
    const subscribers: AgentSessionEventListener[] = [];
    const fake = {
      subscribe(fn: AgentSessionEventListener) {
        subscribers.push(fn);
        return () => {};
      },
      getContextUsage() {
        throw new Error("synthetic failure");
      },
      getSessionStats() {
        return {
          sessionId: "s",
          sessionFile: undefined,
          userMessages: 0,
          assistantMessages: 0,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: 0,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: 0,
        };
      },
    };
    const rec = new ContextTelemetryRecorder({
      session: fake as unknown as AgentSession,
      db,
      agentId: "a",
      now: () => 1,
    });
    rec.start();
    subscribers[0]({ type: "agent_end", messages: [] } as AgentSessionEvent);
    // Row still landed, just without context_tokens/window/percent.
    const rows = listRecentContextStats(db, "a", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].context_tokens).toBeNull();
    expect(rows[0].context_window).toBeNull();
    expect(rows[0].context_percent).toBeNull();
  });
});
