import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MemoryEngine } from "../../src/memory/engine";

let tmpDir: string;
let dbPath: string;
let engine: MemoryEngine;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "spindle-tombstone-"));
  dbPath = join(tmpDir, "memory.db");
  engine = await MemoryEngine.open({ database_path: dbPath });
  engine.registerAgent("alice", "Alice");
});

afterEach(() => {
  engine.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function storeMemory(content: string): Promise<number> {
  return engine.store("alice", { content });
}

describe("engine.tombstone", () => {
  it("tombstones an active memory and records the reason", async () => {
    const id = await storeMemory("ephemeral fact");
    const count = engine.tombstone([id], "test_reason");
    expect(count).toBe(1);

    const row = engine.getById("alice", id, undefined, {
      includeTombstoned: true,
    });
    expect(row).not.toBeNull();
    expect(row!.tombstonedAt).toBeGreaterThan(0);
    expect(row!.tombstoneReason).toBe("test_reason");
  });

  it("is idempotent — re-tombstoning an already-tombstoned row is a no-op", async () => {
    const id = await storeMemory("rewriteme");
    const first = engine.tombstone([id], "first");
    expect(first).toBe(1);
    const second = engine.tombstone([id], "second");
    expect(second).toBe(0);

    const row = engine.getById("alice", id, undefined, {
      includeTombstoned: true,
    });
    expect(row!.tombstoneReason).toBe("first");
  });

  it("handles an empty id list", () => {
    expect(engine.tombstone([], "noop")).toBe(0);
  });

  it("tombstones a subset when the input mixes active + tombstoned ids", async () => {
    const a = await storeMemory("memory a");
    const b = await storeMemory("memory b");
    engine.tombstone([a], "pre");
    const count = engine.tombstone([a, b], "bulk");
    expect(count).toBe(1); // only b transitions
  });
});

describe("engine.restoreTombstoned", () => {
  it("reverses a tombstone and clears the reason", async () => {
    const id = await storeMemory("comes back");
    engine.tombstone([id], "mistake");
    expect(engine.getById("alice", id)).toBeNull();

    const restored = engine.restoreTombstoned([id]);
    expect(restored).toBe(1);

    const row = engine.getById("alice", id);
    expect(row).not.toBeNull();
    expect(row!.tombstonedAt).toBeNull();
    expect(row!.tombstoneReason).toBeNull();
  });

  it("is a no-op on an already-active row", async () => {
    const id = await storeMemory("never tombstoned");
    expect(engine.restoreTombstoned([id])).toBe(0);
  });

  it("handles an empty id list", () => {
    expect(engine.restoreTombstoned([])).toBe(0);
  });
});

describe("engine.listTombstoned", () => {
  it("returns rows owned by the agent, newest-tombstoned first", async () => {
    const a = await storeMemory("first");
    const b = await storeMemory("second");
    const c = await storeMemory("third");

    engine.tombstone([a], "r1");
    await new Promise((r) => setTimeout(r, 2));
    engine.tombstone([b], "r2");
    await new Promise((r) => setTimeout(r, 2));
    engine.tombstone([c], "r3");

    const rows = engine.listTombstoned("alice");
    expect(rows.map((r) => r.id)).toEqual([c, b, a]);
    expect(rows.every((r) => r.tombstonedAt !== null)).toBe(true);
  });

  it("respects the limit option", async () => {
    for (let i = 0; i < 5; i++) {
      const id = await storeMemory(`memory ${i}`);
      engine.tombstone([id], "r");
    }
    const rows = engine.listTombstoned("alice", { limit: 3 });
    expect(rows.length).toBe(3);
  });

  it("only surfaces rows owned by the calling agent", async () => {
    engine.registerAgent("bob", "Bob");
    const aliceMem = await storeMemory("alice private");
    const bobMem = await engine.store("bob", { content: "bob private" });

    engine.tombstone([aliceMem], "alice_reason");
    engine.tombstone([bobMem], "bob_reason");

    const aliceList = engine.listTombstoned("alice");
    expect(aliceList.map((r) => r.id)).toEqual([aliceMem]);

    const bobList = engine.listTombstoned("bob");
    expect(bobList.map((r) => r.id)).toEqual([bobMem]);
  });

  it("returns empty when no tombstoned rows exist", () => {
    expect(engine.listTombstoned("alice")).toEqual([]);
  });
});
