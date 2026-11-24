import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Database } from "bun:sqlite";
import {
  parseLocalCommand,
  LocalCommandRegistry,
  createDefaultLocalCommands,
  newSessionCommand,
  type LocalCommand,
} from "../../../src/channels/telegram/local-commands";
import { ContextTelemetryRecorder } from "../../../src/telemetry/recorder";
import {
  bindTelemetryRecorder,
  resetTelemetryBinding,
} from "../../../src/telemetry/binding";
import { listRecentCompactEvents } from "../../../src/telemetry/store";
import { applyPragmas, runMigrations } from "../../../src/memory/schema";
import type {
  AgentSession,
  AgentSessionEventListener,
} from "@earendil-works/pi-coding-agent";

describe("parseLocalCommand", () => {
  it("parses a bare command", () => {
    expect(parseLocalCommand("/new")).toEqual({ name: "new", args: "" });
  });

  it("parses a command with args", () => {
    expect(parseLocalCommand("/compact focus on recent changes")).toEqual({
      name: "compact",
      args: "focus on recent changes",
    });
  });

  it("strips leading slashes (handles // typos)", () => {
    expect(parseLocalCommand("//new")).toEqual({ name: "new", args: "" });
  });

  it("lowercases the command name", () => {
    expect(parseLocalCommand("/NEW")).toEqual({ name: "new", args: "" });
  });

  it("trims args whitespace", () => {
    expect(parseLocalCommand("/compact   some instructions   ")).toEqual({
      name: "compact",
      args: "some instructions",
    });
  });

  it("returns null for plain text", () => {
    expect(parseLocalCommand("hello world")).toBeNull();
  });

  it("returns null for malformed slash input", () => {
    expect(parseLocalCommand("/has spaces in name")).not.toBeNull();
    expect(parseLocalCommand("/")).toBeNull();
    expect(parseLocalCommand("/-dash")).toBeNull();
  });
});

describe("LocalCommandRegistry", () => {
  it("registers and retrieves commands case-insensitively", () => {
    const r = new LocalCommandRegistry();
    const cmd: LocalCommand = {
      name: "new",
      description: "d",
      handler: async () => {},
    };
    r.register(cmd);
    expect(r.get("new")).toBe(cmd);
    expect(r.get("NEW")).toBe(cmd);
    expect(r.has("new")).toBe(true);
    expect(r.has("missing")).toBe(false);
  });

  it("asSlashCommandInfo returns Telegram-compatible descriptors", () => {
    const r = new LocalCommandRegistry();
    r.register({ name: "alpha", description: "first", handler: async () => {} });
    r.register({ name: "beta", description: "second", handler: async () => {} });
    const info = r.asSlashCommandInfo();
    expect(info).toHaveLength(2);
    expect(info[0]).toEqual({ name: "alpha", description: "first", source: "extension" });
  });
});

// ==================== Built-in command handlers ====================

function makeSessionMock(): {
  session: AgentSession;
  newSession: ReturnType<typeof vi.fn>;
  compact: ReturnType<typeof vi.fn>;
} {
  const newSession = vi.fn(async () => true);
  const compact = vi.fn(async () => ({
    summary: "summary text",
    firstKeptEntryId: "entry-1",
    tokensBefore: 12345,
  }));

  const session = {
    newSession,
    compact,
    sessionManager: {
      getSessionId: () => "sess-abc",
      getSessionName: () => "my session",
      getSessionFile: () => "/path/to/sess-abc.jsonl",
      getEntries: () => new Array(7).fill({}),
      getLeafId: () => "leaf-7",
    },
  } as unknown as AgentSession;

  return { session, newSession, compact };
}

describe("createDefaultLocalCommands", () => {
  it("returns compact and session — NOT /new (intentional)", () => {
    const names = createDefaultLocalCommands().map((c) => c.name);
    expect(names).toContain("compact");
    expect(names).toContain("session");
    expect(names).not.toContain("new");
  });

  it("newSessionCommand is exported and replies not-supported (pi 0.70+ removed newSession)", async () => {
    const { session, newSession } = makeSessionMock();
    const reply = vi.fn();
    await newSessionCommand.handler("", { session, reply });
    // AgentSession.newSession() was removed in pi 0.70+ — the handler
    // must not attempt it, and should tell the user to restart with --new.
    expect(newSession).not.toHaveBeenCalled();
    expect(reply.mock.calls[0][0]).toMatch(/not supported/i);
    expect(reply.mock.calls[0][0]).toMatch(/--new/);
  });

  it("/compact without args compacts and reports token count", async () => {
    const { session, compact } = makeSessionMock();
    const cmd = createDefaultLocalCommands().find((c) => c.name === "compact")!;
    const reply = vi.fn();
    await cmd.handler("", { session, reply });
    expect(compact).toHaveBeenCalledWith(undefined);
    // Two replies: "Compacting…" + "Session compacted"
    expect(reply).toHaveBeenCalledTimes(2);
    expect(reply.mock.calls[1][0]).toMatch(/12,345 tokens/);
  });

  it("/compact with args passes custom instructions", async () => {
    const { session, compact } = makeSessionMock();
    const cmd = createDefaultLocalCommands().find((c) => c.name === "compact")!;
    await cmd.handler("keep the auth details", { session, reply: () => {} });
    expect(compact).toHaveBeenCalledWith("keep the auth details");
  });

  it("/compact surfaces errors", async () => {
    const session = {
      compact: async () => {
        throw new Error("boom");
      },
    } as unknown as AgentSession;
    const cmd = createDefaultLocalCommands().find((c) => c.name === "compact")!;
    const reply = vi.fn();
    await cmd.handler("", { session, reply });
    // Last reply describes the error
    expect(reply.mock.calls.at(-1)?.[0]).toMatch(/failed.*boom/i);
  });

  it("/session returns session info from the session manager", async () => {
    const { session } = makeSessionMock();
    const cmd = createDefaultLocalCommands().find((c) => c.name === "session")!;
    const reply = vi.fn();
    await cmd.handler("", { session, reply });
    const text = reply.mock.calls[0][0] as string;
    expect(text).toContain("sess-abc");
    expect(text).toContain("my session");
    expect(text).toContain("entries: 7");
    expect(text).toContain("leaf-7");
  });
});

// ==================== Telemetry bracketing ====================
//
// Pi's session.compact() does NOT emit the auto_compaction_start/end
// events the recorder subscribes to — it only fires those for its own
// threshold-triggered runs. So for operator-triggered /compact to show
// up in compact_events, the command handler must bracket the call via
// recordExternalCompactStart/End. These tests pin that contract.

function makeTelemetrySession(
  compactImpl: () => Promise<{ tokensBefore?: number }>,
  opts: { contextTokensAfter?: number } = {}
): AgentSession {
  // The recorder's constructor calls session.subscribe(), so we need a
  // minimal subscribe stub even though we never emit any events here.
  return {
    subscribe(_fn: AgentSessionEventListener) {
      return () => {};
    },
    compact: compactImpl,
    sessionManager: {
      getSessionId: () => "sess-xyz",
      getSessionFile: () => "/tmp/sess-xyz.jsonl",
    },
    getContextUsage: () =>
      typeof opts.contextTokensAfter === "number"
        ? {
            tokens: opts.contextTokensAfter,
            contextWindow: 128_000,
            percent:
              (opts.contextTokensAfter / 128_000) * 100,
          }
        : undefined,
    getSessionStats: () => ({
      sessionId: "sess-xyz",
      sessionFile: "/tmp/sess-xyz.jsonl",
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    }),
  } as unknown as AgentSession;
}

describe("/compact telemetry bracketing", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyPragmas(db);
    runMigrations(db);
    resetTelemetryBinding();
  });

  afterEach(() => {
    resetTelemetryBinding();
    db.close();
  });

  it("records a user_manual compact_event with instructions_source=none when no args", async () => {
    const session = makeTelemetrySession(async () => ({ tokensBefore: 12345 }));
    const rec = new ContextTelemetryRecorder({ session, db, agentId: "a" });
    rec.start();
    bindTelemetryRecorder(rec);

    const cmd = createDefaultLocalCommands().find((c) => c.name === "compact")!;
    await cmd.handler("", { session, reply: () => {} });

    const rows = listRecentCompactEvents(db, "a", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger).toBe("user_manual");
    expect(rows[0].reason).toBe("telegram /compact");
    expect(rows[0].instructions_source).toBe("none");
    expect(rows[0].tokens_before).toBe(12345);
    expect(rows[0].ended_at).not.toBeNull();
    expect(rows[0].aborted).toBe(0);
    expect(rows[0].error).toBeNull();

    rec.stop();
  });

  it("populates tokens_after from post-compact getContextUsage() and shows before → after in reply", async () => {
    const session = makeTelemetrySession(
      async () => ({ tokensBefore: 40_000 }),
      { contextTokensAfter: 9_000 }
    );
    const rec = new ContextTelemetryRecorder({ session, db, agentId: "a" });
    rec.start();
    bindTelemetryRecorder(rec);

    const cmd = createDefaultLocalCommands().find((c) => c.name === "compact")!;
    const reply = vi.fn();
    await cmd.handler("", { session, reply });

    const rows = listRecentCompactEvents(db, "a", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].tokens_before).toBe(40_000);
    expect(rows[0].tokens_after).toBe(9_000);

    // Reply should be "40,000 → 9,000 tokens, 78% reduction"
    const successReply = reply.mock.calls.at(-1)?.[0] as string;
    expect(successReply).toMatch(/40,000 → 9,000 tokens/);
    expect(successReply).toMatch(/78% reduction/);

    rec.stop();
  });

  it("leaves tokens_after null when getContextUsage is unavailable (graceful)", async () => {
    const session = makeTelemetrySession(
      async () => ({ tokensBefore: 20_000 })
      // no contextTokensAfter → getContextUsage returns undefined
    );
    const rec = new ContextTelemetryRecorder({ session, db, agentId: "a" });
    rec.start();
    bindTelemetryRecorder(rec);

    const cmd = createDefaultLocalCommands().find((c) => c.name === "compact")!;
    const reply = vi.fn();
    await cmd.handler("", { session, reply });

    const rows = listRecentCompactEvents(db, "a", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].tokens_before).toBe(20_000);
    expect(rows[0].tokens_after).toBeNull();

    // Falls back to the old reply format
    const successReply = reply.mock.calls.at(-1)?.[0] as string;
    expect(successReply).toMatch(/20,000 tokens compacted/);

    rec.stop();
  });

  it("records instructions_source=static when operator supplied text", async () => {
    const session = makeTelemetrySession(async () => ({ tokensBefore: 9000 }));
    const rec = new ContextTelemetryRecorder({ session, db, agentId: "a" });
    rec.start();
    bindTelemetryRecorder(rec);

    const cmd = createDefaultLocalCommands().find((c) => c.name === "compact")!;
    await cmd.handler("preserve the auth flow", { session, reply: () => {} });

    const rows = listRecentCompactEvents(db, "a", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].instructions_source).toBe("static");

    rec.stop();
  });

  it("records aborted+error when session.compact throws", async () => {
    const session = makeTelemetrySession(async () => {
      throw new Error("context too large");
    });
    const rec = new ContextTelemetryRecorder({ session, db, agentId: "a" });
    rec.start();
    bindTelemetryRecorder(rec);

    const cmd = createDefaultLocalCommands().find((c) => c.name === "compact")!;
    const reply = vi.fn();
    await cmd.handler("", { session, reply });

    const rows = listRecentCompactEvents(db, "a", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].aborted).toBe(1);
    expect(rows[0].error).toBe("context too large");
    // Reply path still runs
    expect(reply.mock.calls.at(-1)?.[0]).toMatch(/failed.*context too large/i);

    rec.stop();
  });

  it("runs without crashing when no recorder is bound (graceful degrade)", async () => {
    // Binding is reset in beforeEach — no recorder available.
    const session = { ...makeSessionMock().session } as AgentSession;
    const cmd = createDefaultLocalCommands().find((c) => c.name === "compact")!;
    const reply = vi.fn();
    await cmd.handler("", { session, reply });
    expect(reply.mock.calls.at(-1)?.[0]).toMatch(/compacted/i);
  });
});
