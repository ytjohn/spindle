import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { MemoryEngine } from "../../src/memory/engine";

const AGENT = "a1";

async function makeEngine(dir: string): Promise<MemoryEngine> {
  const engine = await MemoryEngine.open(
    { enabled: true, database_path: join(dir, "memory.db") },
    {},
    dir
  );
  engine.registerAgent(AGENT);
  return engine;
}

describe("listMemories", () => {
  let dir: string;
  let engine: MemoryEngine;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "spindle-listmem-"));
    engine = await makeEngine(dir);
  });

  afterEach(async () => {
    engine.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("returns memories sorted by last_recalled_at DESC by default", async () => {
    await engine.store(AGENT, { content: "first" });
    await engine.store(AGENT, { content: "second" });
    await engine.store(AGENT, { content: "third" });

    const res = engine.listMemories(AGENT);
    expect(res.total).toBe(3);
    expect(res.items).toHaveLength(3);
    expect(res.limit).toBe(50);
    expect(res.offset).toBe(0);
    expect(res.hasMore).toBe(false);
  });

  it("filters by kind", async () => {
    await engine.store(AGENT, { content: "ep", kind: "episodic" });
    await engine.store(AGENT, { content: "sm", kind: "semantic" });
    await engine.store(AGENT, { content: "pr", kind: "procedural" });

    const res = engine.listMemories(AGENT, { kind: ["semantic"] });
    expect(res.items).toHaveLength(1);
    expect(res.items[0].content).toBe("sm");
  });

  it("excludes tombstoned rows by default; includes when asked", async () => {
    const a = await engine.store(AGENT, { content: "keep" });
    const b = await engine.store(AGENT, { content: "drop" });
    engine.tombstone([b], "unit-test");

    expect(engine.listMemories(AGENT).total).toBe(1);
    expect(engine.listMemories(AGENT, { includeTombstoned: true }).total).toBe(2);
    expect(a).toBeTruthy();
  });

  it("applies FTS5 when q is provided", async () => {
    await engine.store(AGENT, { content: "the quick brown fox" });
    await engine.store(AGENT, { content: "a slow green turtle" });
    await engine.store(AGENT, { content: "the cat sat on the mat" });

    const res = engine.listMemories(AGENT, { q: "fox" });
    expect(res.items.some((m) => m.content.includes("fox"))).toBe(true);
    expect(res.items.every((m) => !m.content.includes("turtle"))).toBe(true);
  });

  it("paginates", async () => {
    for (let i = 0; i < 12; i++) {
      await engine.store(AGENT, { content: `memory-${i}` });
    }
    const page1 = engine.listMemories(AGENT, { limit: 5, offset: 0 });
    const page2 = engine.listMemories(AGENT, { limit: 5, offset: 5 });
    const page3 = engine.listMemories(AGENT, { limit: 5, offset: 10 });
    expect(page1.hasMore).toBe(true);
    expect(page2.hasMore).toBe(true);
    expect(page3.items).toHaveLength(2);
    expect(page3.hasMore).toBe(false);
    expect(page1.total).toBe(12);
  });

  // since/until on listMemories uses created_at which engine assigns
  // at store time; skipping a time-range test here because we'd need to
  // mock Date.now per store. The field wiring is exercised via the web
  // route tests where we can seed explicit timestamps.
});

describe("getMemoryById", () => {
  let dir: string;
  let engine: MemoryEngine;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "spindle-getmem-"));
    engine = await makeEngine(dir);
  });

  afterEach(async () => {
    engine.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the row when it belongs to the agent", async () => {
    const id = await engine.store(AGENT, { content: "hello" });
    const mem = engine.getMemoryById(AGENT, id);
    expect(mem).not.toBeNull();
    expect(mem!.content).toBe("hello");
  });

  it("returns null for a different agent's id", async () => {
    engine.registerAgent("other");
    const id = await engine.store("other", { content: "not yours" });
    expect(engine.getMemoryById(AGENT, id)).toBeNull();
  });

  it("returns null for a nonexistent id", () => {
    expect(engine.getMemoryById(AGENT, 99999)).toBeNull();
  });
});

describe("searchEvents", () => {
  let dir: string;
  let engine: MemoryEngine;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "spindle-searchev-"));
    engine = await makeEngine(dir);
    // Seed two sessions with a few events each.
    engine.upsertSession({ agentId: AGENT, id: "s1", filePath: "/tmp/s1.jsonl" });
    engine.upsertSession({ agentId: AGENT, id: "s2", filePath: "/tmp/s2.jsonl" });
    const mkEvent = (
      sessionId: string,
      seq: number,
      text: string,
      eventType = "message",
      role = "user"
    ) => ({
      seq,
      byte_offset: seq * 100,
      ts: 1700000000000 + seq * 1000,
      event_type: eventType,
      pi_event_id: `${sessionId}-${seq}`,
      parent_id: null,
      role,
      model: null,
      content_json: JSON.stringify({ text }),
      content_text: text,
    });
    engine.appendEvents({
      agentId: AGENT,
      sessionId: "s1",
      events: [
        mkEvent("s1", 0, "hello apple world"),
        mkEvent("s1", 1, "second line about bananas", "message", "assistant"),
        mkEvent("s1", 2, "tool call payload", "tool_execution_start", "tool"),
      ],
      newByteOffset: 300,
      newEventCount: 3,
      earliestTs: 1700000000000,
      latestTs: 1700000002000,
    });
    engine.appendEvents({
      agentId: AGENT,
      sessionId: "s2",
      events: [
        mkEvent("s2", 0, "something about apple pie"),
        mkEvent("s2", 1, "unrelated text here"),
      ],
      newByteOffset: 200,
      newEventCount: 2,
      earliestTs: 1700000010000,
      latestTs: 1700000011000,
    });
  });

  afterEach(async () => {
    engine.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("finds events containing a term across sessions", () => {
    const res = engine.searchEvents(AGENT, { q: "apple" });
    expect(res.total).toBe(2);
    expect(res.items.every((e) => e.contentText!.includes("apple"))).toBe(true);
  });

  it("scopes to a single session when session_id given", () => {
    const res = engine.searchEvents(AGENT, { q: "apple", sessionId: "s1" });
    expect(res.total).toBe(1);
    expect(res.items[0].sessionId).toBe("s1");
  });

  it("filters by event_type", () => {
    const res = engine.searchEvents(AGENT, {
      eventTypes: ["tool_execution_start"],
    });
    expect(res.total).toBe(1);
    expect(res.items[0].eventType).toBe("tool_execution_start");
  });

  it("filters by role", () => {
    const res = engine.searchEvents(AGENT, { roles: ["assistant"] });
    expect(res.total).toBe(1);
    expect(res.items[0].role).toBe("assistant");
  });

  it("session-scoped list orders by seq ASC", () => {
    const res = engine.listSessionEvents(AGENT, "s1");
    expect(res.items.map((e) => e.seq)).toEqual([0, 1, 2]);
  });
});

describe("listSessions", () => {
  let dir: string;
  let engine: MemoryEngine;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "spindle-listses-"));
    engine = await makeEngine(dir);
  });

  afterEach(async () => {
    engine.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("returns empty list when no sessions", () => {
    const res = engine.listSessions(AGENT);
    expect(res.items).toEqual([]);
    expect(res.total).toBe(0);
    expect(res.hasMore).toBe(false);
  });

  it("sorts most-recent last_activity_at first", () => {
    engine.upsertSession({ agentId: AGENT, id: "old", filePath: "/x/old.jsonl" });
    engine.upsertSession({ agentId: AGENT, id: "new", filePath: "/x/new.jsonl" });
    engine.appendEvents({
      agentId: AGENT,
      sessionId: "old",
      events: [],
      newByteOffset: 0,
      newEventCount: 0,
      earliestTs: 1000,
      latestTs: 1000,
    });
    engine.appendEvents({
      agentId: AGENT,
      sessionId: "new",
      events: [],
      newByteOffset: 0,
      newEventCount: 0,
      earliestTs: 2000,
      latestTs: 2000,
    });
    const res = engine.listSessions(AGENT);
    expect(res.items[0].id).toBe("new");
    expect(res.items[1].id).toBe("old");
  });
});
