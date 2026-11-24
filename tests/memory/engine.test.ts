import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MemoryEngine, resolveMemoryDbPath } from "../../src/memory/engine";
import { EmbeddingClient } from "../../src/memory/embedding";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "spindle-mem-"));
  dbPath = join(tmpDir, "memory.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function openEngine(): Promise<MemoryEngine> {
  return MemoryEngine.open({ database_path: dbPath });
}

describe("MemoryEngine.open + close", () => {
  it("creates the DB file and runs migrations on first open", async () => {
    const engine = await openEngine();
    // Registering an agent succeeds → migrations ran
    engine.registerAgent("test-agent", "Test");
    engine.close();
  });

  it("close is idempotent", async () => {
    const engine = await openEngine();
    engine.close();
    expect(() => engine.close()).not.toThrow();
  });

  it("throws on operations after close", async () => {
    const engine = await openEngine();
    engine.close();
    expect(() => engine.registerAgent("x")).toThrow(/closed/);
  });
});

describe("MemoryEngine.registerAgent", () => {
  it("upserts new agents", async () => {
    const engine = await openEngine();
    const record = engine.registerAgent("alice", "Alice");
    expect(record.id).toBe("alice");
    expect(record.displayName).toBe("Alice");
    expect(record.createdAt).toBeGreaterThan(0);
    expect(record.lastSeenAt).toBeGreaterThan(0);
    engine.close();
  });

  it("updates last_seen_at on re-register", async () => {
    const engine = await openEngine();
    const first = engine.registerAgent("alice", "Alice");
    await new Promise((r) => setTimeout(r, 5));
    const second = engine.registerAgent("alice", "Alice");
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.lastSeenAt).toBeGreaterThanOrEqual(first.lastSeenAt);
    engine.close();
  });
});

describe("MemoryEngine.store + getById", () => {
  it("stores a memory with default visibility and kind", async () => {
    const engine = await openEngine();
    engine.registerAgent("juno");
    const id = await engine.store("juno", { content: "the cat is named Pixel" });
    expect(id).toBeGreaterThan(0);
    const memory = engine.getById("juno", id);
    expect(memory).not.toBeNull();
    expect(memory?.content).toBe("the cat is named Pixel");
    expect(memory?.visibility).toBe("private");
    expect(memory?.kind).toBe("semantic");
    expect(memory?.threadId).toBeNull();
    expect(memory?.recallCount).toBe(0);
    expect(memory?.lastRecalledAt).toBeNull();
    engine.close();
  });

  it("stores metadata as JSON and returns it parsed", async () => {
    const engine = await openEngine();
    engine.registerAgent("juno");
    const id = await engine.store("juno", {
      content: "fact",
      metadata: { source: "telegram", confidence: 0.8 },
    });
    const memory = engine.getById("juno", id);
    expect(memory?.metadata).toEqual({ source: "telegram", confidence: 0.8 });
    engine.close();
  });

  it("store with visibility='thread' requires threadId", async () => {
    const engine = await openEngine();
    engine.registerAgent("juno");
    await expect(
      engine.store("juno", { content: "hi", visibility: "thread" })
    ).rejects.toThrow(/threadId/);
    engine.close();
  });

  it("store with visibility='thread' and threadId persists the thread id", async () => {
    const engine = await openEngine();
    engine.registerAgent("juno");
    const id = await engine.store("juno", {
      content: "audit note",
      visibility: "thread",
      threadId: "audit:a",
    });
    // Thread-visibility memories only resolve when getById is called with
    // the thread context — that's the visibility model (see visibility.ts).
    expect(engine.getById("juno", id)).toBeNull();
    const memory = engine.getById("juno", id, { id: "audit:a" });
    expect(memory?.visibility).toBe("thread");
    expect(memory?.threadId).toBe("audit:a");
    engine.close();
  });

  it("getById respects visibility — agent B cannot read agent A's private memory", async () => {
    const engine = await openEngine();
    engine.registerAgent("juno");
    engine.registerAgent("casey");
    const id = await engine.store("juno", { content: "juno secret", visibility: "private" });
    expect(engine.getById("juno", id)).not.toBeNull();
    expect(engine.getById("casey", id)).toBeNull();
    engine.close();
  });

  it("getById returns shared memories to any agent", async () => {
    const engine = await openEngine();
    engine.registerAgent("juno");
    engine.registerAgent("casey");
    const id = await engine.store("juno", { content: "common fact", visibility: "shared" });
    expect(engine.getById("juno", id)).not.toBeNull();
    expect(engine.getById("casey", id)).not.toBeNull();
    engine.close();
  });
});

describe("MemoryEngine.recall (FTS5, no embeddings)", () => {
  async function seed(): Promise<MemoryEngine> {
    const engine = await openEngine();
    engine.registerAgent("juno");
    engine.registerAgent("casey");
    await engine.store("juno", { content: "the user has a cat named Pixel" });
    await engine.store("juno", { content: "the user's favorite color is blue" });
    await engine.store("juno", { content: "the user lives in Lisbon" });
    await engine.store("juno", {
      content: "casey secret memory",
      visibility: "private",
    });
    await engine.store("casey", {
      content: "casey private cat observation",
      visibility: "private",
    });
    await engine.store("casey", {
      content: "the user prefers short responses",
      visibility: "shared",
    });
    return engine;
  }

  it("recall by keyword returns the matching memory", async () => {
    const engine = await seed();
    const results = await engine.recall("juno", { query: "Pixel" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].memory.content).toContain("Pixel");
    engine.close();
  });

  it("recall respects private visibility — one agent does NOT see another's private memory", async () => {
    const engine = await seed();
    const results = await engine.recall("juno", { query: "cat" });
    const contents = results.map((r) => r.memory.content);
    expect(contents.some((c) => c.includes("Pixel"))).toBe(true);
    expect(contents.some((c) => c.includes("casey private cat"))).toBe(false);
    engine.close();
  });

  it("recall includes shared memories from any agent", async () => {
    const engine = await seed();
    const results = await engine.recall("juno", { query: "responses" });
    expect(results.map((r) => r.memory.content)).toContain(
      "the user prefers short responses"
    );
    engine.close();
  });

  it("recall returns empty array when no matches", async () => {
    const engine = await seed();
    const results = await engine.recall("juno", { query: "zzzzzzzzz" });
    expect(results).toEqual([]);
    engine.close();
  });

  it("recall respects limit", async () => {
    const engine = await seed();
    const results = await engine.recall("juno", { query: "user", limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
    engine.close();
  });

  it("recall bumps recall_count and last_recalled_at on returned memories", async () => {
    const engine = await seed();
    const first = await engine.recall("juno", { query: "Pixel" });
    expect(first[0].memory.recallCount).toBe(1);
    expect(first[0].memory.lastRecalledAt).not.toBeNull();
    const memoryId = first[0].memory.id;
    const second = await engine.recall("juno", { query: "Pixel" });
    expect(second[0].memory.id).toBe(memoryId);
    expect(second[0].memory.recallCount).toBe(2);
    engine.close();
  });

  it("thread memories are NOT included without a thread context", async () => {
    const engine = await openEngine();
    engine.registerAgent("juno");
    await engine.store("juno", { content: "audit note about nagios" });
    await engine.store("juno", {
      content: "thread only note about nagios",
      visibility: "thread",
      threadId: "audit:nagios:2026-04-11",
    });
    const results = await engine.recall("juno", { query: "nagios" });
    const contents = results.map((r) => r.memory.content);
    expect(contents).toContain("audit note about nagios");
    expect(contents).not.toContain("thread only note about nagios");
    engine.close();
  });

  it("thread memories ARE included with exact threadId match", async () => {
    const engine = await openEngine();
    engine.registerAgent("juno");
    await engine.store("juno", {
      content: "audit detail A",
      visibility: "thread",
      threadId: "audit:nagios:2026-04-11",
    });
    await engine.store("juno", {
      content: "audit detail B",
      visibility: "thread",
      threadId: "audit:nagios:2026-04-12",
    });
    const results = await engine.recall("juno", {
      query: "audit",
      threadId: "audit:nagios:2026-04-11",
    });
    const contents = results.map((r) => r.memory.content);
    expect(contents).toContain("audit detail A");
    expect(contents).not.toContain("audit detail B");
    engine.close();
  });

  it("thread pattern includes all matching threads", async () => {
    const engine = await openEngine();
    engine.registerAgent("juno");
    await engine.store("juno", {
      content: "nagios april eleven",
      visibility: "thread",
      threadId: "audit:nagios:2026-04-11",
    });
    await engine.store("juno", {
      content: "nagios april twelve",
      visibility: "thread",
      threadId: "audit:nagios:2026-04-12",
    });
    await engine.store("juno", {
      content: "backup april eleven",
      visibility: "thread",
      threadId: "audit:backup:2026-04-11",
    });
    const results = await engine.recall("juno", {
      query: "nagios",
      threadPattern: "audit:nagios:%",
    });
    const contents = results.map((r) => r.memory.content);
    expect(contents).toContain("nagios april eleven");
    expect(contents).toContain("nagios april twelve");
    expect(contents).not.toContain("backup april eleven");
    engine.close();
  });

  it("treats FTS5 operators as literal tokens (no injection / no syntax errors)", async () => {
    const engine = await openEngine();
    engine.registerAgent("juno");
    await engine.store("juno", { content: "plain content" });
    // Words like AND / OR / NEAR / NOT in the query should be treated as
    // literal tokens (quoted), so they don't crash the parser or modify
    // the match semantics. The query tokenizes to "plain" OR "AND" OR
    // "NEAR" OR "nothing" OR "matches", and "plain" matches our row.
    const results = await engine.recall("juno", {
      query: "plain AND NEAR nothing-matches",
    });
    expect(results.length).toBe(1);
    expect(results[0].memory.content).toBe("plain content");
    engine.close();
  });

  it("returns empty results for all-punctuation queries", async () => {
    const engine = await openEngine();
    engine.registerAgent("juno");
    await engine.store("juno", { content: "real content" });
    const results = await engine.recall("juno", { query: "!!!???" });
    expect(results).toEqual([]);
    engine.close();
  });
});

describe("MemoryEngine.listRecent", () => {
  it("returns memories in newest-first order", async () => {
    const engine = await openEngine();
    engine.registerAgent("juno");
    const id1 = await engine.store("juno", { content: "first" });
    await new Promise((r) => setTimeout(r, 2));
    const id2 = await engine.store("juno", { content: "second" });
    await new Promise((r) => setTimeout(r, 2));
    const id3 = await engine.store("juno", { content: "third" });
    const recent = engine.listRecent("juno", 10);
    expect(recent.map((m) => m.id)).toEqual([id3, id2, id1]);
    engine.close();
  });

  it("respects the limit parameter", async () => {
    const engine = await openEngine();
    engine.registerAgent("juno");
    for (let i = 0; i < 5; i++) {
      await engine.store("juno", { content: `m${i}` });
    }
    const recent = engine.listRecent("juno", 3);
    expect(recent).toHaveLength(3);
    engine.close();
  });

  it("enforces visibility — does not return another agent's private memories", async () => {
    const engine = await openEngine();
    engine.registerAgent("juno");
    engine.registerAgent("casey");
    await engine.store("juno", { content: "juno-secret", visibility: "private" });
    await engine.store("casey", { content: "casey-secret", visibility: "private" });
    await engine.store("juno", { content: "shared-fact", visibility: "shared" });

    const junoRecent = engine.listRecent("juno", 10);
    const caseyRecent = engine.listRecent("casey", 10);
    expect(junoRecent.map((m) => m.content)).toEqual(["shared-fact", "juno-secret"]);
    expect(caseyRecent.map((m) => m.content)).toEqual(["shared-fact", "casey-secret"]);
    engine.close();
  });

  it("returns empty array when no memories exist", async () => {
    const engine = await openEngine();
    engine.registerAgent("juno");
    expect(engine.listRecent("juno", 10)).toEqual([]);
    engine.close();
  });
});

describe("MemoryEngine.countVisible", () => {
  it("counts each agent's visible set correctly", async () => {
    const engine = await openEngine();
    engine.registerAgent("juno");
    engine.registerAgent("casey");
    await engine.store("juno", { content: "j1", visibility: "private" });
    await engine.store("juno", { content: "j2", visibility: "private" });
    await engine.store("juno", { content: "shared1", visibility: "shared" });
    await engine.store("casey", { content: "c1", visibility: "private" });
    await engine.store("casey", { content: "shared2", visibility: "shared" });

    // the first agent sees: 2 private + 2 shared = 4
    expect(engine.countVisible("juno")).toBe(4);
    // the second agent sees: 1 private + 2 shared = 3
    expect(engine.countVisible("casey")).toBe(3);
    engine.close();
  });
});

// ============================================================================
// Concurrent writes — real WAL exercise
// ============================================================================

describe("MemoryEngine concurrency (file-backed WAL)", () => {
  it("handles interleaved writes from two engine instances without deadlock", async () => {
    const engineA = await MemoryEngine.open({ database_path: dbPath });
    const engineB = await MemoryEngine.open({ database_path: dbPath });
    try {
      engineA.registerAgent("agent-a");
      engineB.registerAgent("agent-b");

      const countPerAgent = 100;
      const writes: Promise<number>[] = [];
      for (let i = 0; i < countPerAgent; i++) {
        writes.push(engineA.store("agent-a", { content: `a-${i}` }));
        writes.push(engineB.store("agent-b", { content: `b-${i}` }));
      }
      await Promise.all(writes);

      // Both engines should see their own writes via recall
      expect(engineA.countVisible("agent-a")).toBe(countPerAgent);
      expect(engineB.countVisible("agent-b")).toBe(countPerAgent);
      // And each agent can see the other's through a fresh engine read
      // (shared DB; private memories stay private but total rows = 2N)
      const agentAFromB = engineB.countVisible("agent-a");
      expect(agentAFromB).toBe(countPerAgent); // agent-a's private memories visible to agent-a only
    } finally {
      engineA.close();
      engineB.close();
    }
  });

  it("write-while-read: recall completes consistently during concurrent writes", async () => {
    const engine = await openEngine();
    engine.registerAgent("juno");
    // Seed a baseline set matching our query
    for (let i = 0; i < 50; i++) {
      await engine.store("juno", { content: `cat fact number ${i}` });
    }
    // Kick off a bunch of writes + reads in parallel
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 50; i++) {
      ops.push(engine.store("juno", { content: `new cat fact ${i}` }));
      ops.push(
        engine.recall("juno", { query: "cat" }).then((results) => {
          // Every recall should return something (we started with 50 matches)
          expect(results.length).toBeGreaterThan(0);
        })
      );
    }
    await Promise.all(ops);
    engine.close();
  });
});

// ============================================================================
// Embeddings integration
// ============================================================================

/**
 * A deterministic mock embedding client. Hashes the text into a
 * Float32Array so identical text → identical vector and similar text →
 * similar vector. Close enough for predictable tests without a real
 * provider.
 */
class MockEmbeddingClient extends EmbeddingClient {
  constructor() {
    super({ provider: "mock", model: "mock" });
  }

  // biome-ignore lint/complexity/noUselessConstructor: override
  override async embed(text: string): Promise<Float32Array> {
    return MockEmbeddingClient.vectorFor(text);
  }

  static vectorFor(text: string): Float32Array {
    // Simple character-code bucketing → 16-dim vector. Same text → same
    // vector; similar text → similar vector. Not a real embedding, just
    // a predictable function for tests.
    const vec = new Float32Array(16);
    for (let i = 0; i < text.length; i++) {
      vec[text.charCodeAt(i) % 16] += 1;
    }
    // Normalize to unit length so cosine sim is well-behaved
    let mag = 0;
    for (let i = 0; i < vec.length; i++) mag += vec[i] * vec[i];
    mag = Math.sqrt(mag) || 1;
    for (let i = 0; i < vec.length; i++) vec[i] /= mag;
    return vec;
  }
}

describe("MemoryEngine with embeddings", () => {
  async function openWithEmbeddings(): Promise<MemoryEngine> {
    return MemoryEngine.open({
      database_path: dbPath,
      embeddingClient: new MockEmbeddingClient(),
    });
  }

  it("hasEmbeddings reflects whether a client was configured", async () => {
    const withEmb = await openWithEmbeddings();
    expect(withEmb.hasEmbeddings).toBe(true);
    withEmb.close();

    const without = await openEngine();
    expect(without.hasEmbeddings).toBe(false);
    without.close();
  });

  it("store persists the embedding blob when a client is present", async () => {
    const engine = await openWithEmbeddings();
    engine.registerAgent("juno");
    const id = await engine.store("juno", { content: "the cat is named Pixel" });
    const memory = engine.getById("juno", id);
    expect(memory?.embedding).toBeInstanceOf(Float32Array);
    expect(memory?.embedding?.length).toBe(16);
    engine.close();
  });

  it("store does NOT persist an embedding when no client is present", async () => {
    const engine = await openEngine();
    engine.registerAgent("juno");
    const id = await engine.store("juno", { content: "plain content" });
    const memory = engine.getById("juno", id);
    expect(memory?.embedding).toBeNull();
    engine.close();
  });

  it("recall uses the query embedding + cosine similarity when embeddings enabled", async () => {
    // Two memories that share the keyword "cat" — one semantically closer
    // to the query than the other. Verify the embedding nudges ranking
    // correctly even when FTS rank is similar.
    const engine = await openWithEmbeddings();
    engine.registerAgent("juno");
    await engine.store("juno", { content: "cat sleeping on the couch" });
    await engine.store("juno", { content: "cat playing with a ball" });
    const results = await engine.recall("juno", {
      query: "cat sleeping on the couch",
      limit: 2,
    });
    expect(results.length).toBe(2);
    // The exact-match content should rank first (cosine = 1 on identical text)
    expect(results[0].memory.content).toBe("cat sleeping on the couch");
  });

  it("recall handles memories WITHOUT embeddings mixed with memories that have them", async () => {
    // Store one memory with an engine that has no embedding client...
    const noEmb = await openEngine();
    noEmb.registerAgent("juno");
    await noEmb.store("juno", { content: "legacy memory about cats" });
    noEmb.close();

    // ...then reopen with embeddings and add another. Recall should
    // return both without crashing.
    const withEmb = await openWithEmbeddings();
    await withEmb.store("juno", { content: "new memory about cats" });
    const results = await withEmb.recall("juno", { query: "cats" });
    const contents = results.map((r) => r.memory.content);
    expect(contents).toContain("legacy memory about cats");
    expect(contents).toContain("new memory about cats");
    withEmb.close();
  });

  it("embedding failure propagates out of store (not silently dropped)", async () => {
    class FailingClient extends EmbeddingClient {
      constructor() {
        super({ provider: "mock", model: "mock" });
      }
      override async embed(): Promise<Float32Array> {
        throw new Error("embedding provider is down");
      }
    }
    const engine = await MemoryEngine.open({
      database_path: dbPath,
      embeddingClient: new FailingClient(),
    });
    engine.registerAgent("juno");
    await expect(engine.store("juno", { content: "test" })).rejects.toThrow(
      /provider is down/
    );
    engine.close();
  });
});

// ============================================================================
// Path resolution
// ============================================================================

describe("resolveMemoryDbPath", () => {
  it("honors explicit config.database_path", () => {
    expect(
      resolveMemoryDbPath({ database_path: "/custom/path/memory.db" }, {})
    ).toBe("/custom/path/memory.db");
  });

  it("expands ~ in config.database_path using $HOME", () => {
    expect(
      resolveMemoryDbPath({ database_path: "~/custom/memory.db" }, { HOME: "/home/test" })
    ).toBe("/home/test/custom/memory.db");
  });

  it("honors SPINDLE_MEMORY_DB env override", () => {
    expect(
      resolveMemoryDbPath({}, { SPINDLE_MEMORY_DB: "/env/override/memory.db" })
    ).toBe("/env/override/memory.db");
  });

  it("uses XDG_DATA_HOME when set and absolute", () => {
    expect(
      resolveMemoryDbPath({}, { XDG_DATA_HOME: "/xdg", HOME: "/home/test" })
    ).toBe("/xdg/spindle/memory.db");
  });

  it("ignores XDG_DATA_HOME when not absolute", () => {
    expect(
      resolveMemoryDbPath({}, { XDG_DATA_HOME: "relative/bad", HOME: "/home/test" })
    ).toBe("/home/test/.local/share/spindle/memory.db");
  });

  it("falls back to $HOME/.local/share/spindle/memory.db", () => {
    expect(resolveMemoryDbPath({}, { HOME: "/home/test" })).toBe(
      "/home/test/.local/share/spindle/memory.db"
    );
  });

  it("config.database_path wins over env and HOME", () => {
    expect(
      resolveMemoryDbPath(
        { database_path: "/explicit.db" },
        { SPINDLE_MEMORY_DB: "/env.db", XDG_DATA_HOME: "/xdg", HOME: "/home/test" }
      )
    ).toBe("/explicit.db");
  });

  it("env override wins over XDG and HOME", () => {
    expect(
      resolveMemoryDbPath(
        {},
        { SPINDLE_MEMORY_DB: "/env.db", XDG_DATA_HOME: "/xdg", HOME: "/home/test" }
      )
    ).toBe("/env.db");
  });

  it("relative database_path resolves against agentDir when provided", () => {
    expect(
      resolveMemoryDbPath(
        { database_path: "./memory.db" },
        {},
        "/home/test/agents/eliza"
      )
    ).toBe("/home/test/agents/eliza/memory.db");
  });

  it("relative database_path resolves against cwd when no agentDir", () => {
    // Using process.cwd() here is fine for the test — resolvePath with a
    // single relative arg uses it. Just assert the path does NOT start
    // with /home/test/agents.
    const resolved = resolveMemoryDbPath({ database_path: "./memory.db" }, {});
    expect(resolved).not.toContain("/home/test/agents");
    expect(resolved.endsWith("/memory.db")).toBe(true);
  });

  it("absolute database_path ignores agentDir", () => {
    expect(
      resolveMemoryDbPath(
        { database_path: "/absolute/memory.db" },
        {},
        "/home/test/agents/eliza"
      )
    ).toBe("/absolute/memory.db");
  });

  it("~-prefixed database_path expands to HOME regardless of agentDir", () => {
    expect(
      resolveMemoryDbPath(
        { database_path: "~/custom/memory.db" },
        { HOME: "/home/test" },
        "/irrelevant/agent/dir"
      )
    ).toBe("/home/test/custom/memory.db");
  });
});

describe("MemoryEngine — access history (Phase 2.1)", () => {
  // Reach into the DB through the engine's internal Database — we open
  // a parallel readonly connection on the same file so we can assert
  // memory_accesses row counts without exposing a public API just for
  // tests.
  function rawAccessRows(
    engine: MemoryEngine,
    memoryId: number
  ): number[] {
    const { Database } = require("bun:sqlite");
    const db = new Database((engine as unknown as { db: { filename: string } }).db.filename, {
      readonly: true,
    });
    try {
      const rows = db
        .query(`SELECT accessed_at FROM memory_accesses WHERE memory_id = ? ORDER BY accessed_at ASC`)
        .all(memoryId) as Array<{ accessed_at: number }>;
      return rows.map((r) => r.accessed_at);
    } finally {
      db.close();
    }
  }

  it("store inserts a synthetic access row at created_at (linear mode)", async () => {
    const engine = await openEngine();
    engine.registerAgent("alice");
    const before = Date.now();
    const id = await engine.store("alice", { content: "linear-mode store test" });
    const after = Date.now();

    const accesses = rawAccessRows(engine, id);
    expect(accesses).toHaveLength(1);
    expect(accesses[0]).toBeGreaterThanOrEqual(before);
    expect(accesses[0]).toBeLessThanOrEqual(after);
    engine.close();
  });

  it("store inserts a synthetic access row in act-r mode too", async () => {
    const engine = await MemoryEngine.open({
      database_path: dbPath,
      weights: { mode: "act-r" },
    });
    engine.registerAgent("alice");
    const id = await engine.store("alice", { content: "act-r mode store test" });
    expect(rawAccessRows(engine, id)).toHaveLength(1);
    engine.close();
  });

  it("recall inserts one access row per returned memory (linear mode)", async () => {
    const engine = await openEngine();
    engine.registerAgent("alice");
    const idA = await engine.store("alice", { content: "alpha bravo" });
    const idB = await engine.store("alice", { content: "alpha charlie" });

    // After store: each has exactly 1 access row.
    expect(rawAccessRows(engine, idA)).toHaveLength(1);
    expect(rawAccessRows(engine, idB)).toHaveLength(1);

    const results = await engine.recall("alice", { query: "alpha" });
    expect(results.length).toBeGreaterThanOrEqual(2);

    // After recall: each returned memory has 1 + 1 = 2 access rows.
    expect(rawAccessRows(engine, idA)).toHaveLength(2);
    expect(rawAccessRows(engine, idB)).toHaveLength(2);

    // A second recall adds another row.
    await engine.recall("alice", { query: "alpha" });
    expect(rawAccessRows(engine, idA)).toHaveLength(3);
    expect(rawAccessRows(engine, idB)).toHaveLength(3);

    engine.close();
  });

  it("recall in act-r mode also writes one access row per returned memory", async () => {
    const engine = await MemoryEngine.open({
      database_path: dbPath,
      weights: { mode: "act-r" },
    });
    engine.registerAgent("alice");
    const id = await engine.store("alice", { content: "delta echo foxtrot" });
    expect(rawAccessRows(engine, id)).toHaveLength(1);

    const results = await engine.recall("alice", { query: "delta" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(rawAccessRows(engine, id)).toHaveLength(2);

    engine.close();
  });

  it("recall in act-r mode produces sane scores against fabricated history", async () => {
    // Two memories with the same query relevance but very different
    // access patterns. ACT-R should rank the frequently-touched one
    // above the rarely-touched one.
    const engine = await MemoryEngine.open({
      database_path: dbPath,
      weights: { mode: "act-r" },
    });
    engine.registerAgent("alice");
    const idHot = await engine.store("alice", { content: "topic identical wording one" });
    const idCold = await engine.store("alice", { content: "topic identical wording two" });

    // Backfill access rows directly: 30 recent touches for hot, none extra for cold.
    const { Database } = require("bun:sqlite");
    const db = new Database(dbPath);
    try {
      const recent = Date.now() - 1000;
      for (let i = 0; i < 30; i++) {
        db.run(
          `INSERT INTO memory_accesses (memory_id, accessed_at) VALUES (?, ?)`,
          [idHot, recent - i * 100]
        );
      }
    } finally {
      db.close();
    }

    const results = await engine.recall("alice", { query: "topic" });
    expect(results.length).toBe(2);
    const hotResult = results.find((r) => r.memory.id === idHot)!;
    const coldResult = results.find((r) => r.memory.id === idCold)!;
    expect(hotResult).toBeDefined();
    expect(coldResult).toBeDefined();
    expect(hotResult.score).toBeGreaterThan(coldResult.score);

    engine.close();
  });

  it("Hebbian links are reinforced on co-recall", async () => {
    const engine = await openEngine();
    engine.registerAgent("alice");
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        await engine.store("alice", { content: `coactivate token-${i}` })
      );
    }
    // First recall: creates the C(5,2) = 10 links at base + bonus.
    const firstResults = await engine.recall("alice", { query: "coactivate", limit: 10 });
    expect(firstResults.length).toBe(5);

    const { Database } = require("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });
    try {
      const linkCount = db.query(`SELECT COUNT(*) AS c FROM links`).get() as { c: number };
      expect(linkCount.c).toBe(10);
      const sample = db
        .query(`SELECT strength, last_reinforced_at FROM links LIMIT 1`)
        .get() as { strength: number; last_reinforced_at: number };
      // Initial INSERT writes BASE_STRENGTH (0.1) — the first co-recall
      // does NOT bump (the bonus only applies on conflict). Subsequent
      // recalls trigger the bump path.
      expect(sample.strength).toBeCloseTo(0.1, 6);
    } finally {
      db.close();
    }

    // Second recall: should bump every existing link by the bonus.
    await engine.recall("alice", { query: "coactivate", limit: 10 });
    const db2 = new Database(dbPath, { readonly: true });
    try {
      const sample = db2
        .query(`SELECT strength FROM links LIMIT 1`)
        .get() as { strength: number };
      expect(sample.strength).toBeCloseTo(0.15, 6); // 0.1 + 0.05
    } finally {
      db2.close();
    }

    engine.close();
  });

  it("link strength is capped at LINK_MAX_STRENGTH (1.0)", async () => {
    const engine = await openEngine();
    engine.registerAgent("alice");
    await engine.store("alice", { content: "ceiling word-a" });
    await engine.store("alice", { content: "ceiling word-b" });
    // First call creates the link at 0.1, then 30 more calls bump
    // by 0.05 each → would be 1.6 unbounded; should clamp at 1.0.
    for (let i = 0; i < 31; i++) {
      await engine.recall("alice", { query: "ceiling", limit: 10 });
    }
    const links = engine.getLinks("alice", 1);
    expect(links).toHaveLength(1);
    expect(links[0].strength).toBeCloseTo(1.0, 6);

    engine.close();
  });

  it("getLinks honors visibility (private memories from other agents are invisible)", async () => {
    const engine = await openEngine();
    engine.registerAgent("alice");
    engine.registerAgent("bob");
    // Two of alice's memories that will be linked, one of bob's that shouldn't appear.
    const a1 = await engine.store("alice", { content: "shared topic widget" });
    const a2 = await engine.store("alice", { content: "shared topic widget two" });
    await engine.store("bob", { content: "shared topic widget" });

    await engine.recall("alice", { query: "widget" }); // links a1 ↔ a2
    // Recall as bob — that creates separate links for bob too, but
    // only between bob's memories. Direction matters: alice can't see
    // bob's; bob can't see alice's.
    await engine.recall("bob", { query: "widget" });

    const aliceLinks = engine.getLinks("alice", a1);
    expect(aliceLinks.every((l) => {
      const neighbor = l.srcId === a1 ? l.dstId : l.srcId;
      return neighbor === a2;
    })).toBe(true);

    // Bob asks about alice's memory id — should see no links from his
    // perspective (alice's neighbor is invisible to him).
    const bobView = engine.getLinks("bob", a1);
    expect(bobView.length).toBe(0);
    engine.close();
  });

  it("getLinks returns decayed effective strength", async () => {
    const engine = await openEngine();
    engine.registerAgent("alice");
    await engine.store("alice", { content: "fade words alpha" });
    await engine.store("alice", { content: "fade words beta" });
    await engine.recall("alice", { query: "fade" });

    // Read links at "now" plus one e-folding time → effective strength
    // should be ~stored / e ≈ 0.0368.
    const future = Date.now() + 14 * 24 * 60 * 60 * 1000;
    const links = engine.getLinks("alice", 1, { now: future });
    expect(links).toHaveLength(1);
    expect(links[0].effectiveStrength).toBeCloseTo(0.1 / Math.E, 4);
    engine.close();
  });

  it("decayLinks() persists fresh decayed values and updates last_reinforced_at", async () => {
    const engine = await openEngine();
    engine.registerAgent("alice");
    await engine.store("alice", { content: "decay candidate one" });
    await engine.store("alice", { content: "decay candidate two" });
    await engine.recall("alice", { query: "decay" });

    // Sweep at "now + 1 e-folding time"
    const future = Date.now() + 14 * 24 * 60 * 60 * 1000;
    const updated = engine.decayLinks(future);
    expect(updated).toBe(1);

    const { Database } = require("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db
        .query(`SELECT strength, last_reinforced_at FROM links LIMIT 1`)
        .get() as { strength: number; last_reinforced_at: number };
      expect(row.strength).toBeCloseTo(0.1 / Math.E, 4);
      expect(row.last_reinforced_at).toBe(future);
    } finally {
      db.close();
    }
    engine.close();
  });

  it("associate() reinforces explicit pairs with the larger bonus", async () => {
    const engine = await openEngine();
    engine.registerAgent("alice");
    const a = await engine.store("alice", { content: "associate alpha" });
    const b = await engine.store("alice", { content: "associate beta" });
    const c = await engine.store("alice", { content: "associate gamma" });

    const result = engine.associate("alice", [a, b, c]);
    expect(result.reinforced).toBe(3); // C(3,2) = 3 pairs
    expect(result.skipped).toBe(0);

    const { Database } = require("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });
    try {
      const linkCount = db
        .query(`SELECT COUNT(*) AS c FROM links`)
        .get() as { c: number };
      expect(linkCount.c).toBe(3);
      const sample = db
        .query(`SELECT strength FROM links LIMIT 1`)
        .get() as { strength: number };
      // First call inserts at BASE_STRENGTH (0.1) — bonus only applies
      // on the upsert conflict path.
      expect(sample.strength).toBeCloseTo(0.1, 6);
    } finally {
      db.close();
    }

    // Second call — bonus 0.15 should bump strengths from 0.1 to 0.25
    engine.associate("alice", [a, b, c]);
    const db2 = new Database(dbPath, { readonly: true });
    try {
      const sample = db2
        .query(`SELECT strength FROM links LIMIT 1`)
        .get() as { strength: number };
      expect(sample.strength).toBeCloseTo(0.25, 6);
    } finally {
      db2.close();
    }

    engine.close();
  });

  it("associate() skips pairs with invisible memories and reports the count", async () => {
    const engine = await openEngine();
    engine.registerAgent("alice");
    engine.registerAgent("bob");
    const a = await engine.store("alice", { content: "alice-only thing" });
    const b = await engine.store("bob", { content: "bob-only thing" }); // private to bob
    // alice tries to associate her memory with bob's private memory.
    const result = engine.associate("alice", [a, b]);
    expect(result.reinforced).toBe(0);
    expect(result.skipped).toBe(1);

    const { Database } = require("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });
    try {
      const linkCount = db
        .query(`SELECT COUNT(*) AS c FROM links`)
        .get() as { c: number };
      expect(linkCount.c).toBe(0);
    } finally {
      db.close();
    }
    engine.close();
  });

  it("associate() with fewer than 2 ids is a no-op", async () => {
    const engine = await openEngine();
    engine.registerAgent("alice");
    const id = await engine.store("alice", { content: "lonely" });
    expect(engine.associate("alice", [id])).toEqual({ reinforced: 0, skipped: 0 });
    expect(engine.associate("alice", [])).toEqual({ reinforced: 0, skipped: 0 });
    engine.close();
  });

  it("association expansion surfaces well-connected memories on partial query match", async () => {
    const engine = await openEngine();
    engine.registerAgent("alice");
    // Three "in-group" memories that share two FTS tokens (cluster +
    // shared) but each has its OWN unique terminal token. The unique
    // tokens are completely disjoint so a query for one of them only
    // matches its memory directly via FTS.
    const ig1 = await engine.store("alice", {
      content: "shared cluster wonderful",
    });
    const ig2 = await engine.store("alice", {
      content: "shared cluster splendid",
    });
    const ig3 = await engine.store("alice", {
      content: "shared cluster delightful",
    });
    // Three "out-group" memories with no overlapping tokens
    await engine.store("alice", { content: "outgroup unrelated topic one" });
    await engine.store("alice", { content: "outgroup unrelated topic two" });
    await engine.store("alice", { content: "outgroup unrelated topic three" });

    // Drive several recalls on the shared tokens so the in-group
    // links strengthen above the noise floor.
    for (let i = 0; i < 5; i++) {
      await engine.recall("alice", { query: "shared cluster" });
    }

    // Now query for ig1's unique token — only ig1 lexically matches.
    // ig2 + ig3 should appear via association expansion.
    const results = await engine.recall("alice", { query: "wonderful" });
    const resultIds = new Set(results.map((r) => r.memory.id));
    expect(resultIds.has(ig1)).toBe(true);
    expect(resultIds.has(ig2)).toBe(true);
    expect(resultIds.has(ig3)).toBe(true);
    // None of the out-group memories should appear via expansion.
    for (const r of results) {
      expect(r.memory.content).not.toContain("outgroup");
    }

    engine.close();
  });

  it("association expansion respects visibility (no cross-agent leakage)", async () => {
    const engine = await openEngine();
    engine.registerAgent("alice");
    engine.registerAgent("bob");
    // Alice has two private memories that get linked.
    const a1 = await engine.store("alice", {
      content: "secret cluster fact alpha",
    });
    const a2 = await engine.store("alice", {
      content: "secret cluster fact beta",
    });
    // Bob has his own private memory that lexically matches alpha.
    await engine.store("bob", { content: "secret cluster fact alpha" });

    // Alice recalls a few times to forge the a1↔a2 link.
    for (let i = 0; i < 3; i++) {
      await engine.recall("alice", { query: "secret cluster" });
    }

    // Bob queries with "alpha" — should find his own private memory,
    // and association expansion should NOT walk into alice's private
    // a2 even though there's a strong alpha-side seed.
    const bobResults = await engine.recall("bob", { query: "alpha" });
    expect(bobResults.length).toBeGreaterThanOrEqual(1);
    for (const r of bobResults) {
      // Bob can only see content he wrote (or shared content). No
      // result should be one of alice's memory ids.
      expect([a1, a2]).not.toContain(r.memory.id);
    }

    engine.close();
  });

  it("association expansion can be disabled via config (opt-out)", async () => {
    const engine = await MemoryEngine.open({
      database_path: dbPath,
      association: { enabled: false },
    });
    engine.registerAgent("alice");
    // Disjoint unique tokens so only ig1 matches the final FTS query.
    const ig1 = await engine.store("alice", {
      content: "shared cluster wonderful",
    });
    const ig2 = await engine.store("alice", {
      content: "shared cluster splendid",
    });
    // Forge the link by recalling on the shared tokens.
    for (let i = 0; i < 3; i++) {
      await engine.recall("alice", { query: "shared cluster" });
    }
    // With expansion off, recalling ig1's unique token should NOT
    // pull ig2 even though the link between them exists.
    const results = await engine.recall("alice", { query: "wonderful" });
    const ids = new Set(results.map((r) => r.memory.id));
    expect(ids.has(ig1)).toBe(true);
    expect(ids.has(ig2)).toBe(false);
    engine.close();
  });

  it("association expansion is a no-op when there are no links yet", async () => {
    const engine = await openEngine();
    engine.registerAgent("alice");
    // First store, no recalls have happened yet → no links table rows.
    await engine.store("alice", { content: "lonely first memory" });
    const results = await engine.recall("alice", { query: "lonely" });
    expect(results.length).toBe(1);
    expect(results[0].memory.content).toBe("lonely first memory");
    engine.close();
  });

  it("memory_accesses cascades when its memory is deleted (cleanup hook for 5.1 GC)", async () => {
    const engine = await openEngine();
    engine.registerAgent("alice");
    const id = await engine.store("alice", { content: "delete me" });
    await engine.recall("alice", { query: "delete" });
    expect(rawAccessRows(engine, id).length).toBeGreaterThanOrEqual(2);

    const { Database } = require("bun:sqlite");
    const db = new Database(dbPath);
    try {
      db.run(`PRAGMA foreign_keys = ON`);
      db.run(`DELETE FROM memories WHERE id = ?`, [id]);
      const remaining = db
        .query(`SELECT COUNT(*) AS c FROM memory_accesses WHERE memory_id = ?`)
        .get(id) as { c: number };
      expect(remaining.c).toBe(0);
    } finally {
      db.close();
    }
    engine.close();
  });
});
