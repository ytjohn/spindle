import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  readSessionEntriesSince,
  summarizeActivity,
  entryToTurn,
  type ActivityTurn,
} from "../../src/daydream/activity";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "spindle-dd-activity-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// entryToTurn — pure function, covers the block-parsing logic
// ============================================================================

describe("entryToTurn", () => {
  it("returns null for the session header entry", () => {
    const entry = {
      type: "session",
      version: 3,
      id: "abc",
      timestamp: "2026-04-12T10:00:00.000Z",
      cwd: "/home/test",
    };
    expect(entryToTurn(entry)).toBeNull();
  });

  it("returns null for model_change entries", () => {
    expect(
      entryToTurn({
        type: "model_change",
        id: "x",
        parentId: "y",
        timestamp: "2026-04-12T10:00:00.000Z",
        provider: "gpu1",
        modelId: "qwen",
      })
    ).toBeNull();
  });

  it("returns null for thinking_level_change entries", () => {
    expect(
      entryToTurn({
        type: "thinking_level_change",
        id: "x",
        parentId: "y",
        timestamp: "2026-04-12T10:00:00.000Z",
        thinkingLevel: "off",
      })
    ).toBeNull();
  });

  it("parses a user message with a single text block", () => {
    const entry = {
      type: "message",
      id: "msg1",
      parentId: null,
      timestamp: "2026-04-12T10:00:00.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "hello there" }],
      },
    };
    const turn = entryToTurn(entry);
    expect(turn).not.toBeNull();
    expect(turn?.role).toBe("user");
    expect(turn?.text).toBe("hello there");
    expect(turn?.toolCalls).toEqual([]);
    expect(turn?.timestamp).toBe(Date.parse("2026-04-12T10:00:00.000Z"));
  });

  it("skips thinking blocks and flattens multiple text blocks", () => {
    const entry = {
      type: "message",
      id: "msg2",
      parentId: "msg1",
      timestamp: "2026-04-12T10:00:05.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me think...", thinkingSignature: "x" },
          { type: "text", text: "First part." },
          { type: "text", text: "Second part." },
        ],
      },
    };
    const turn = entryToTurn(entry);
    expect(turn?.text).toBe("First part.\nSecond part.");
    expect(turn?.toolCalls).toEqual([]);
  });

  it("captures toolCall names", () => {
    const entry = {
      type: "message",
      id: "msg3",
      parentId: "msg2",
      timestamp: "2026-04-12T10:00:10.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Storing that." },
          { type: "toolCall", id: "call1", name: "spindle_memory_store", arguments: {} },
          { type: "toolCall", id: "call2", name: "spindle_memory_recall", arguments: {} },
        ],
      },
    };
    const turn = entryToTurn(entry);
    expect(turn?.toolCalls).toEqual(["spindle_memory_store", "spindle_memory_recall"]);
  });

  it("handles string content form", () => {
    const entry = {
      type: "message",
      id: "msg4",
      parentId: null,
      timestamp: "2026-04-12T10:00:00.000Z",
      message: { role: "user", content: "plain string message" },
    };
    const turn = entryToTurn(entry);
    expect(turn?.text).toBe("plain string message");
  });

  it("returns null for unknown roles", () => {
    const entry = {
      type: "message",
      id: "msg5",
      parentId: null,
      timestamp: "2026-04-12T10:00:00.000Z",
      message: { role: "system", content: [{ type: "text", text: "..." }] },
    };
    expect(entryToTurn(entry)).toBeNull();
  });

  it("returns null for entries with missing timestamp", () => {
    const entry = {
      type: "message",
      id: "msg6",
      parentId: null,
      message: { role: "user", content: "hi" },
    };
    expect(entryToTurn(entry)).toBeNull();
  });

  it("returns null for entries with invalid timestamp", () => {
    const entry = {
      type: "message",
      id: "msg7",
      parentId: null,
      timestamp: "not a date",
      message: { role: "user", content: "hi" },
    };
    expect(entryToTurn(entry)).toBeNull();
  });

  it("returns null for non-object inputs", () => {
    expect(entryToTurn(null)).toBeNull();
    expect(entryToTurn(undefined)).toBeNull();
    expect(entryToTurn("string")).toBeNull();
    expect(entryToTurn(42)).toBeNull();
  });
});

// ============================================================================
// readSessionEntriesSince — file I/O + watermark filter
// ============================================================================

/** Build a session JSONL file with header + messages and return the path. */
function writeFixture(
  name: string,
  messages: Array<{ role: string; timestamp: string; text: string; toolCalls?: string[] }>
): string {
  const path = join(tmpDir, name);
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      type: "session",
      version: 3,
      id: "test-session",
      timestamp: "2026-04-12T09:00:00.000Z",
      cwd: "/home/test",
    })
  );
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const content: unknown[] = [{ type: "text", text: m.text }];
    if (m.toolCalls) {
      for (const name of m.toolCalls) {
        content.push({ type: "toolCall", id: `call-${i}-${name}`, name, arguments: {} });
      }
    }
    lines.push(
      JSON.stringify({
        type: "message",
        id: `msg-${i}`,
        parentId: i === 0 ? null : `msg-${i - 1}`,
        timestamp: m.timestamp,
        message: { role: m.role, content },
      })
    );
  }
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

describe("readSessionEntriesSince", () => {
  it("returns empty array for missing file", () => {
    expect(
      readSessionEntriesSince(join(tmpDir, "does-not-exist.jsonl"), 0)
    ).toEqual([]);
  });

  it("returns empty array for file with only a session header", () => {
    const path = writeFixture("header-only.jsonl", []);
    expect(readSessionEntriesSince(path, 0)).toEqual([]);
  });

  it("returns all message entries when sinceMs is 0", () => {
    const path = writeFixture("three-turns.jsonl", [
      { role: "user", timestamp: "2026-04-12T10:00:00.000Z", text: "hi" },
      { role: "assistant", timestamp: "2026-04-12T10:00:05.000Z", text: "hello" },
      { role: "user", timestamp: "2026-04-12T10:00:10.000Z", text: "how are you" },
    ]);
    const turns = readSessionEntriesSince(path, 0);
    expect(turns).toHaveLength(3);
    expect(turns.map((t) => t.text)).toEqual(["hi", "hello", "how are you"]);
  });

  it("filters entries older than sinceMs", () => {
    const path = writeFixture("filter-test.jsonl", [
      { role: "user", timestamp: "2026-04-12T10:00:00.000Z", text: "old" },
      { role: "user", timestamp: "2026-04-12T10:05:00.000Z", text: "also old" },
      { role: "user", timestamp: "2026-04-12T10:10:00.000Z", text: "boundary" },
      { role: "user", timestamp: "2026-04-12T10:15:00.000Z", text: "new" },
    ]);
    const since = Date.parse("2026-04-12T10:10:00.000Z");
    const turns = readSessionEntriesSince(path, since);
    expect(turns.map((t) => t.text)).toEqual(["boundary", "new"]);
  });

  it("skips malformed lines without failing the whole parse", () => {
    const path = join(tmpDir, "malformed.jsonl");
    const good1 = JSON.stringify({
      type: "message",
      id: "a",
      timestamp: "2026-04-12T10:00:00.000Z",
      message: { role: "user", content: "first" },
    });
    const good2 = JSON.stringify({
      type: "message",
      id: "b",
      timestamp: "2026-04-12T10:00:01.000Z",
      message: { role: "user", content: "second" },
    });
    writeFileSync(path, [good1, "not json at all", good2].join("\n"));
    const turns = readSessionEntriesSince(path, 0);
    expect(turns).toHaveLength(2);
    expect(turns.map((t) => t.text)).toEqual(["first", "second"]);
  });
});

// ============================================================================
// summarizeActivity — prose rendering
// ============================================================================

function turn(
  role: ActivityTurn["role"],
  tsIso: string,
  text: string,
  toolCalls: string[] = []
): ActivityTurn {
  return { role, timestamp: Date.parse(tsIso), text, toolCalls };
}

describe("summarizeActivity", () => {
  const NOW = Date.parse("2026-04-12T10:20:00.000Z");

  it("returns a no-activity message for empty input", () => {
    expect(summarizeActivity([], NOW)).toContain("No new conversational activity");
  });

  it("returns a no-activity message when only toolResult turns present", () => {
    const turns = [turn("toolResult", "2026-04-12T10:00:00.000Z", "result text")];
    expect(summarizeActivity(turns, NOW)).toContain("No new conversational activity");
  });

  it("renders user + assistant turns with timestamps", () => {
    const turns = [
      turn("user", "2026-04-12T10:00:00.000Z", "hello"),
      turn("assistant", "2026-04-12T10:00:05.000Z", "hi there"),
    ];
    const out = summarizeActivity(turns, NOW);
    expect(out).toContain("2 turns");
    expect(out).toContain("user: hello");
    expect(out).toContain("assistant: hi there");
  });

  it("annotates assistant tool calls inline", () => {
    const turns = [
      turn("user", "2026-04-12T10:00:00.000Z", "remember this"),
      turn(
        "assistant",
        "2026-04-12T10:00:05.000Z",
        "stored",
        ["spindle_memory_store"]
      ),
    ];
    const out = summarizeActivity(turns, NOW);
    expect(out).toContain("(called spindle_memory_store)");
  });

  it("formats elapsed time — minutes", () => {
    const turns = [
      turn("user", "2026-04-12T10:00:00.000Z", "start"),
      turn("user", "2026-04-12T10:05:00.000Z", "end"),
    ];
    const out = summarizeActivity(turns, NOW);
    // 10:20 - 10:00 = 20m elapsed from the oldest turn
    expect(out).toMatch(/last 20m/);
  });

  it("formats elapsed time — hours + minutes", () => {
    const hourAgo = Date.parse("2026-04-12T09:05:00.000Z");
    const turns = [
      turn("user", new Date(hourAgo).toISOString(), "long ago"),
      turn("user", "2026-04-12T10:15:00.000Z", "recent"),
    ];
    const out = summarizeActivity(turns, NOW);
    expect(out).toMatch(/last 1h 15m/);
  });

  it("uses singular 'turn' for exactly one turn", () => {
    const turns = [turn("user", "2026-04-12T10:15:00.000Z", "just one")];
    const out = summarizeActivity(turns, NOW);
    expect(out).toMatch(/1 turn over/);
    expect(out).not.toMatch(/1 turns/);
  });

  it("collapses multi-line turn text into a single line", () => {
    const turns = [
      turn("user", "2026-04-12T10:00:00.000Z", "first line\n\nsecond line\nthird"),
    ];
    const out = summarizeActivity(turns, NOW);
    expect(out).toContain("first line second line third");
    expect(out).not.toContain("first line\n\nsecond");
  });

  it("drops oldest turns when summary exceeds maxChars", () => {
    const turns: ActivityTurn[] = [];
    for (let i = 0; i < 20; i++) {
      const ts = new Date(
        Date.parse("2026-04-12T10:00:00.000Z") + i * 60_000
      ).toISOString();
      turns.push(
        turn("user", ts, `this is turn number ${i} with some padding text to take space`)
      );
    }
    const out = summarizeActivity(turns, NOW, { maxChars: 300 });
    expect(out).toMatch(/elided for length/);
    expect(out.length).toBeLessThan(400);
    // Should keep the newest turns
    expect(out).toContain("turn number 19");
    // Should have dropped the oldest
    expect(out).not.toContain("turn number 0 ");
  });

  it("does not elide when input fits within maxChars", () => {
    const turns = [
      turn("user", "2026-04-12T10:00:00.000Z", "short"),
      turn("assistant", "2026-04-12T10:00:05.000Z", "also short"),
    ];
    const out = summarizeActivity(turns, NOW, { maxChars: 1000 });
    expect(out).not.toMatch(/elided/);
  });
});
