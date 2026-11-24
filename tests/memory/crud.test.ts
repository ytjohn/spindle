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

describe("updateMemory", () => {
  let dir: string;
  let engine: MemoryEngine;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "spindle-update-"));
    engine = await makeEngine(dir);
  });

  afterEach(async () => {
    engine.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("updates content and FTS5 reflects the change", async () => {
    const id = await engine.store(AGENT, { content: "first version" });
    const updated = engine.updateMemory(AGENT, id, { content: "second version" });
    expect(updated).not.toBeNull();
    expect(updated!.content).toBe("second version");

    const hits = engine.listMemories(AGENT, { q: "second" });
    expect(hits.total).toBe(1);
    const stale = engine.listMemories(AGENT, { q: "first" });
    expect(stale.total).toBe(0);
  });

  it("updates kind + visibility + metadata", async () => {
    const id = await engine.store(AGENT, { content: "x", kind: "semantic" });
    const updated = engine.updateMemory(AGENT, id, {
      kind: "episodic",
      visibility: "private",
      metadata: { foo: "bar" },
    });
    expect(updated!.kind).toBe("episodic");
    expect(updated!.metadata).toEqual({ foo: "bar" });
  });

  it("returns null for a different agent's id", async () => {
    engine.registerAgent("other");
    const id = await engine.store("other", { content: "x" });
    expect(engine.updateMemory(AGENT, id, { content: "nope" })).toBeNull();
  });

  it("returns null for a nonexistent id", () => {
    expect(engine.updateMemory(AGENT, 99999, { content: "x" })).toBeNull();
  });

  it("throws on empty patch", async () => {
    const id = await engine.store(AGENT, { content: "x" });
    expect(() => engine.updateMemory(AGENT, id, {})).toThrow(/no fields/);
  });

  it("rejects visibility=thread without thread_id", async () => {
    const id = await engine.store(AGENT, { content: "x" });
    expect(() =>
      engine.updateMemory(AGENT, id, { visibility: "thread" })
    ).toThrow(/thread_id/);
  });

  it("accepts visibility=thread when thread_id is supplied in the same patch", async () => {
    const id = await engine.store(AGENT, { content: "x" });
    const updated = engine.updateMemory(AGENT, id, {
      visibility: "thread",
      threadId: "audit:t1",
    });
    expect(updated!.visibility).toBe("thread");
    expect(updated!.threadId).toBe("audit:t1");
  });

  it("sets metadata back to null when explicitly passed null", async () => {
    const id = await engine.store(AGENT, {
      content: "x",
      metadata: { keep: true },
    });
    const updated = engine.updateMemory(AGENT, id, { metadata: null });
    expect(updated!.metadata).toBeNull();
  });
});

describe("tombstoneScoped / restoreScoped", () => {
  let dir: string;
  let engine: MemoryEngine;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "spindle-tomb-"));
    engine = await makeEngine(dir);
  });

  afterEach(async () => {
    engine.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("tombstones an active row and returns the updated Memory", async () => {
    const id = await engine.store(AGENT, { content: "goner" });
    const result = engine.tombstoneScoped(AGENT, id, "operator:web-ui");
    expect(result).not.toBeNull();
    expect(result!.tombstonedAt).not.toBeNull();
    expect(result!.tombstoneReason).toBe("operator:web-ui");
  });

  it("tombstoneScoped returns null for a different agent's id", async () => {
    engine.registerAgent("other");
    const id = await engine.store("other", { content: "x" });
    expect(engine.tombstoneScoped(AGENT, id, "r")).toBeNull();
  });

  it("tombstoneScoped returns null for already-tombstoned row", async () => {
    const id = await engine.store(AGENT, { content: "x" });
    engine.tombstoneScoped(AGENT, id, "r1");
    expect(engine.tombstoneScoped(AGENT, id, "r2")).toBeNull();
  });

  it("restoreScoped un-tombstones a tombstoned row", async () => {
    const id = await engine.store(AGENT, { content: "x" });
    engine.tombstoneScoped(AGENT, id, "r");
    const restored = engine.restoreScoped(AGENT, id);
    expect(restored).not.toBeNull();
    expect(restored!.tombstonedAt).toBeNull();
    expect(restored!.tombstoneReason).toBeNull();
  });

  it("restoreScoped returns null for an active row", async () => {
    const id = await engine.store(AGENT, { content: "x" });
    expect(engine.restoreScoped(AGENT, id)).toBeNull();
  });

  it("restoreScoped returns null for a different agent's id", async () => {
    engine.registerAgent("other");
    const id = await engine.store("other", { content: "x" });
    engine.tombstone([id], "r");
    expect(engine.restoreScoped(AGENT, id)).toBeNull();
  });
});
