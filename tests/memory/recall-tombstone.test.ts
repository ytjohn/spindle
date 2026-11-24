import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MemoryEngine } from "../../src/memory/engine";

let tmpDir: string;
let dbPath: string;
let engine: MemoryEngine;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "spindle-recall-tomb-"));
  dbPath = join(tmpDir, "memory.db");
});

afterEach(() => {
  engine.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function setupEngine(opts?: { actR?: boolean }): Promise<void> {
  engine = await MemoryEngine.open({
    database_path: dbPath,
    scoring: opts?.actR ? { mode: "act-r" } : undefined,
  });
  engine.registerAgent("alice", "Alice");
}

describe("tombstoned rows are excluded from every recall path", () => {
  it("recall() does not return a tombstoned row even on a direct FTS match", async () => {
    await setupEngine();
    const keep = await engine.store("alice", { content: "alice loves sushi" });
    const drop = await engine.store("alice", { content: "alice loves pickled herring" });
    engine.tombstone([drop], "test");

    const results = await engine.recall("alice", { query: "loves" });
    const ids = results.map((r) => r.memory.id);
    expect(ids).toContain(keep);
    expect(ids).not.toContain(drop);
  });

  it("listRecent() skips tombstoned rows", async () => {
    await setupEngine();
    const a = await engine.store("alice", { content: "first" });
    const b = await engine.store("alice", { content: "second" });
    const c = await engine.store("alice", { content: "third" });
    engine.tombstone([b], "skip");

    const recent = engine.listRecent("alice", 10);
    const ids = recent.map((m) => m.id);
    expect(ids).toContain(a);
    expect(ids).toContain(c);
    expect(ids).not.toContain(b);
  });

  it("getById returns null on a tombstoned row by default", async () => {
    await setupEngine();
    const id = await engine.store("alice", { content: "hidden" });
    engine.tombstone([id], "x");
    expect(engine.getById("alice", id)).toBeNull();
  });

  it("getById with includeTombstoned: true returns the row", async () => {
    await setupEngine();
    const id = await engine.store("alice", { content: "hidden" });
    engine.tombstone([id], "admin_audit");
    const row = engine.getById("alice", id, undefined, {
      includeTombstoned: true,
    });
    expect(row).not.toBeNull();
    expect(row!.tombstonedAt).toBeGreaterThan(0);
    expect(row!.tombstoneReason).toBe("admin_audit");
  });

  it("countVisible excludes tombstoned rows", async () => {
    await setupEngine();
    const a = await engine.store("alice", { content: "one" });
    await engine.store("alice", { content: "two" });
    await engine.store("alice", { content: "three" });
    expect(engine.countVisible("alice")).toBe(3);
    engine.tombstone([a], "drop");
    expect(engine.countVisible("alice")).toBe(2);
  });

  it("association expansion does not surface a tombstoned neighbor", async () => {
    await setupEngine();
    // Seed a lexical anchor and an association target. Associate them
    // explicitly so expansion picks the neighbor up even without an FTS
    // hit on the second memory's content.
    const anchor = await engine.store("alice", { content: "purple widget" });
    const neighbor = await engine.store("alice", {
      content: "completely unrelated phrase",
    });
    engine.associate("alice", [anchor, neighbor]);

    // Sanity: expansion surfaces the neighbor before tombstoning
    const before = await engine.recall("alice", { query: "purple" });
    expect(before.map((r) => r.memory.id)).toContain(neighbor);

    // After tombstoning the neighbor, it should be invisible even
    // though the link in the `links` table still exists on disk
    engine.tombstone([neighbor], "drop_neighbor");
    const after = await engine.recall("alice", { query: "purple" });
    expect(after.map((r) => r.memory.id)).not.toContain(neighbor);
    expect(after.map((r) => r.memory.id)).toContain(anchor);
  });

  it("ACT-R scoring mode skips tombstoned rows", async () => {
    await setupEngine({ actR: true });
    const keep = await engine.store("alice", { content: "cats purr contentedly" });
    const drop = await engine.store("alice", { content: "cats nap in the sun" });
    engine.tombstone([drop], "t");
    const results = await engine.recall("alice", { query: "cats" });
    const ids = results.map((r) => r.memory.id);
    expect(ids).toContain(keep);
    expect(ids).not.toContain(drop);
  });
});
