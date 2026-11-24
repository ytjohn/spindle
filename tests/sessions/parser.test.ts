import { describe, it, expect } from "vitest";
import { parseEventLine } from "../../src/sessions/parser";

function ok(line: string) {
  const r = parseEventLine(line, 0);
  if (r.error) throw new Error(`unexpected parse error: ${r.message}`);
  return r.event;
}

describe("parseEventLine", () => {
  it("projects a session header line", () => {
    const line = JSON.stringify({
      type: "session",
      version: 3,
      id: "abc",
      timestamp: "2026-04-16T12:51:12.973Z",
      cwd: "/tmp/x",
    });
    const e = ok(line);
    expect(e.event_type).toBe("session");
    expect(e.pi_event_id).toBe("abc");
    expect(e.parent_id).toBeNull();
    expect(e.ts).toBe(Date.parse("2026-04-16T12:51:12.973Z"));
    expect(e.role).toBeNull();
    expect(e.model).toBeNull();
    expect(e.content_text).toBeNull();
    expect(e.content_json).toBe(line);
  });

  it("projects a user message with text block", () => {
    const line = JSON.stringify({
      type: "message",
      id: "u1",
      parentId: "hdr",
      timestamp: "2026-04-16T12:52:00.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "Good morning — how about that purple goo?" }],
        timestamp: 1776343920000,
      },
    });
    const e = ok(line);
    expect(e.role).toBe("user");
    expect(e.model).toBeNull();
    expect(e.content_text).toBe("Good morning — how about that purple goo?");
  });

  it("projects an assistant message with thinking + text + skips thinking from text", () => {
    const line = JSON.stringify({
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-04-16T12:52:03.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "secret internal reasoning" },
          { type: "text", text: "Hello!" },
        ],
        model: "qwen3.5-35b",
        provider: "local-vllm",
      },
    });
    const e = ok(line);
    expect(e.role).toBe("assistant");
    expect(e.model).toBe("qwen3.5-35b");
    expect(e.content_text).toBe("Hello!");
    // thinking is NOT in content_text but IS in content_json
    expect(e.content_json).toContain("secret internal reasoning");
  });

  it("extracts tool_use name + args into content_text", () => {
    const line = JSON.stringify({
      type: "message",
      id: "a2",
      timestamp: "2026-04-16T12:52:10.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "read",
            input: { file: "src/index.ts", line: 42 },
          },
        ],
      },
    });
    const e = ok(line);
    expect(e.content_text).toContain("read(");
    expect(e.content_text).toContain("file=");
    expect(e.content_text).toContain("src/index.ts");
  });

  it("extracts tool_result string content into content_text", () => {
    const line = JSON.stringify({
      type: "message",
      id: "t1",
      timestamp: "2026-04-16T12:52:20.000Z",
      message: {
        role: "tool",
        content: [{ type: "tool_result", content: "the file contents" }],
      },
    });
    const e = ok(line);
    expect(e.content_text).toBe("the file contents");
  });

  it("extracts tool_result array content into content_text", () => {
    const line = JSON.stringify({
      type: "message",
      id: "t2",
      timestamp: "2026-04-16T12:52:30.000Z",
      message: {
        role: "tool",
        content: [
          {
            type: "tool_result",
            content: [{ type: "text", text: "result line 1" }],
          },
        ],
      },
    });
    const e = ok(line);
    expect(e.content_text).toBe("result line 1");
  });

  it("returns content_text NULL for non-message events", () => {
    const line = JSON.stringify({
      type: "tool_execution_start",
      id: "ts1",
      parentId: "a1",
      timestamp: "2026-04-16T12:52:11.000Z",
      tool: "read",
    });
    const e = ok(line);
    expect(e.content_text).toBeNull();
    expect(e.event_type).toBe("tool_execution_start");
    expect(e.parent_id).toBe("a1");
  });

  it("returns an error on malformed JSON", () => {
    const r = parseEventLine('{"type":"message", BROKEN', 42);
    expect(r.error).toBe(true);
    if (r.error) {
      expect(r.byte_offset).toBe(42);
      expect(r.message).toMatch(/json parse/);
    }
  });

  it("returns an error on missing .type", () => {
    const r = parseEventLine(JSON.stringify({ id: "x" }), 0);
    expect(r.error).toBe(true);
    if (r.error) expect(r.message).toMatch(/missing \.type/);
  });

  it("returns an error on empty line", () => {
    const r = parseEventLine("", 0);
    expect(r.error).toBe(true);
    if (r.error) expect(r.message).toMatch(/empty/);
  });

  it("handles null parentId", () => {
    const line = JSON.stringify({
      type: "model_change",
      id: "mc",
      parentId: null,
      timestamp: "2026-04-16T12:51:13.000Z",
    });
    const e = ok(line);
    expect(e.parent_id).toBeNull();
  });

  it("clips very long tool_use args", () => {
    const huge = "x".repeat(500);
    const line = JSON.stringify({
      type: "message",
      id: "a3",
      timestamp: "2026-04-16T12:52:40.000Z",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "bash", input: { cmd: huge } }],
      },
    });
    const e = ok(line);
    expect(e.content_text!.length).toBeLessThanOrEqual(260);
  });
});
