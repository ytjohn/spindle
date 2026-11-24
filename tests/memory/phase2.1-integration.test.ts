/**
 * Phase 2.1 integration tests.
 *
 * Unit tests for the individual primitives (reinforcement, decay,
 * ACT-R math, association expansion) already live in
 * tests/memory/{scoring,engine,schema,extension}.test.ts. THIS file
 * exercises the end-to-end behavior on a realistic multi-memory
 * corpus so future changes to scoring or reinforcement can't
 * silently break the observable behavior we validated live against
 * eliza-memory.
 *
 * The seed corpus mirrors the Eliza E2E session that validated
 * Phase 2.1: 5 memories about a dog and a cat, varied vocabulary so
 * different queries match different subsets. No LLM, no daydream —
 * just the engine primitives, driven end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MemoryEngine } from "../../src/memory/engine";

// ============================================================================
// Seed corpus (mirrors the eliza-memory E2E validation)
// ============================================================================

const CORPUS = [
  { slug: "dog-name", content: "user's dog is named Sati Ann, nicknamed Satan" },
  {
    slug: "dog-breed",
    content: "user's dog is an Australian Shepherd with a Blue Merle coat",
  },
  { slug: "dog-age", content: "user's dog is one year old" },
  { slug: "cat-age", content: "user has a 12-year-old cat named Silver" },
  {
    slug: "cat-origin",
    content: "user picked up their cat Silver in Lisbon",
  },
] as const;

type Slug = (typeof CORPUS)[number]["slug"];

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "spindle-p2.1-integ-"));
  dbPath = join(tmpDir, "memory.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function seed(engine: MemoryEngine): Promise<Record<Slug, number>> {
  engine.registerAgent("eliza-memory", "Eliza");
  const ids = {} as Record<Slug, number>;
  for (const entry of CORPUS) {
    ids[entry.slug] = await engine.store("eliza-memory", {
      content: entry.content,
    });
  }
  return ids;
}

// ============================================================================
// Tests
// ============================================================================

describe("Phase 2.1 integration — realistic corpus + co-recall dynamics", () => {
  it("recall_count and access_count reconcile after N recalls in both modes", async () => {
    // Invariant from Phase 2.1 design: each memory's memory_accesses
    // row count equals its recall_count + 1 (the +1 is the synthetic
    // store-time row). Holds in both scoring modes because access
    // writes happen regardless of mode.
    for (const mode of ["linear", "act-r"] as const) {
      const engine = await MemoryEngine.open({
        database_path: join(tmpDir, `${mode}.db`),
        weights: { mode },
      });
      const ids = await seed(engine);

      // Drive a few recalls that hit different subsets.
      await engine.recall("eliza-memory", { query: "dog" }); // matches 3 dog memories
      await engine.recall("eliza-memory", { query: "Silver cat" }); // matches 2 cat memories
      await engine.recall("eliza-memory", { query: "Lisbon" }); // direct hit on 1, associations possible

      // Reach into the underlying DB to count access rows per memory.
      const db = (engine as unknown as {
        db: { query: (sql: string) => { all: () => Array<{ memory_id: number; c: number }> } };
      }).db;
      const rows = db
        .query(
          `SELECT memory_id, COUNT(*) AS c FROM memory_accesses GROUP BY memory_id`
        )
        .all();
      const accessByMemory = new Map<number, number>();
      for (const r of rows) accessByMemory.set(r.memory_id, r.c);

      for (const slug of Object.keys(ids) as Slug[]) {
        const id = ids[slug];
        const mem = engine.getById("eliza-memory", id)!;
        const accessCount = accessByMemory.get(id) ?? 0;
        // Synthetic store row + one row per recall that returned this memory.
        expect(accessCount).toBe(mem.recallCount + 1);
      }

      engine.close();
    }
  });

  it("multi-recall produces two-tier link strengths when a memory misses one batch", async () => {
    // Observed in the live E2E: when a memory is in fewer recall
    // batches than its peers, its links to peers stay at base
    // strength while peers' mutual links get bumped. This test
    // reproduces that pattern deterministically.
    const engine = await MemoryEngine.open({ database_path: dbPath });
    const ids = await seed(engine);

    // Recall 1: all 5 dog+cat memories match via their shared "user's" token.
    // (The tokenizer drops the apostrophe-s so "user" is the active token.)
    // Every pair gets a link inserted at BASE_STRENGTH (0.1).
    await engine.recall("eliza-memory", { query: "user has a pet" });

    // Recall 2: only the 3 dog memories match directly. The top-K here
    // is [dog-name, dog-breed, dog-age] — their 3 mutual links get
    // bumped to 0.15. Links touching cat-age/cat-origin stay at 0.10.
    // (Association expansion may pull in cat memories, but the test
    // turns it OFF so we can assert on the direct-phase behavior.)
    engine.close();
    const engine2 = await MemoryEngine.open({
      database_path: dbPath,
      association: { enabled: false },
    });
    engine2.registerAgent("eliza-memory");
    await engine2.recall("eliza-memory", { query: "dog Australian Shepherd" });

    // Now inspect the links table directly.
    const db = (engine2 as unknown as {
      db: {
        query: (sql: string) => {
          all: () => Array<{ src_id: number; dst_id: number; strength: number }>;
        };
      };
    }).db;
    const links = db.query(`SELECT src_id, dst_id, strength FROM links`).all();

    // Classify each link as "dog-only" (both endpoints are dog memories)
    // or "mixed" (at least one cat memory). Dog-only links should be
    // 0.15 (bumped once); mixed links should be 0.10 (base strength).
    const dogIds = new Set([ids["dog-name"], ids["dog-breed"], ids["dog-age"]]);
    const catIds = new Set([ids["cat-age"], ids["cat-origin"]]);

    const dogOnly = links.filter(
      (l) => dogIds.has(l.src_id) && dogIds.has(l.dst_id)
    );
    const mixed = links.filter(
      (l) =>
        (dogIds.has(l.src_id) && catIds.has(l.dst_id)) ||
        (catIds.has(l.src_id) && dogIds.has(l.dst_id))
    );
    const catOnly = links.filter(
      (l) => catIds.has(l.src_id) && catIds.has(l.dst_id)
    );

    expect(dogOnly.length).toBe(3); // C(3,2)
    expect(mixed.length).toBe(6); // 3 dog × 2 cat
    expect(catOnly.length).toBe(1); // C(2,2)

    for (const l of dogOnly) expect(l.strength).toBeCloseTo(0.15, 6);
    for (const l of mixed) expect(l.strength).toBeCloseTo(0.10, 6);
    for (const l of catOnly) expect(l.strength).toBeCloseTo(0.10, 6);

    engine2.close();
  });

  it("association expansion pulls in linked non-matching memories on narrow queries", async () => {
    // Observed live: a query for "Lisbon" directly matches only
    // cat-origin, but association expansion surfaces every other
    // memory that shares a Hebbian link with it from prior recalls.
    // This test reproduces that behavior deterministically.
    //
    // Bump per_seed to 4 so all 4 neighbors of the single direct
    // match surface (default is 3). Defaults are correct for typical
    // recall patterns with more than one seed; this test's single-
    // direct-match pattern is atypical.
    const engine = await MemoryEngine.open({
      database_path: dbPath,
      association: { perSeed: 4 },
    });
    const ids = await seed(engine);

    // Forge links across the entire corpus with a broad recall.
    await engine.recall("eliza-memory", { query: "user" });

    // Now do a narrow query that only directly matches cat-origin.
    const results = await engine.recall("eliza-memory", { query: "Lisbon" });

    const resultIds = new Set(results.map((r) => r.memory.id));
    expect(resultIds.has(ids["cat-origin"])).toBe(true); // direct hit
    // Every other corpus member should appear via association expansion.
    expect(resultIds.has(ids["cat-age"])).toBe(true);
    expect(resultIds.has(ids["dog-name"])).toBe(true);
    expect(resultIds.has(ids["dog-breed"])).toBe(true);
    expect(resultIds.has(ids["dog-age"])).toBe(true);

    // And the direct match should rank first — its fts_rank dominates.
    expect(results[0].memory.id).toBe(ids["cat-origin"]);

    engine.close();
  });

  it("association expansion opt-out returns only FTS-direct matches on the same corpus", async () => {
    const engine = await MemoryEngine.open({
      database_path: dbPath,
      association: { enabled: false },
    });
    const ids = await seed(engine);

    // Forge links (has no effect on opt-out behavior, but exercises
    // that reinforcement still runs in opt-out mode).
    await engine.recall("eliza-memory", { query: "user" });

    const results = await engine.recall("eliza-memory", { query: "Lisbon" });
    const resultIds = new Set(results.map((r) => r.memory.id));
    expect(resultIds.has(ids["cat-origin"])).toBe(true);
    // None of the non-matching memories should appear.
    expect(resultIds.has(ids["cat-age"])).toBe(false);
    expect(resultIds.has(ids["dog-name"])).toBe(false);
    expect(resultIds.has(ids["dog-breed"])).toBe(false);
    expect(resultIds.has(ids["dog-age"])).toBe(false);

    engine.close();
  });

  it("linear and act-r modes agree on the strongest direct match but diverge on the association tail", async () => {
    // Observed in the E2E compare script: ACT-R and linear both put
    // the strongest direct match at rank #1, but reshuffle the
    // association-expanded tail because the two modes weight recency
    // vs cumulative activation differently. This test pins that the
    // strongest direct match stays at rank #1 across modes and that
    // the full result sets are the same set of ids (the ordering may
    // differ for lower-ranked entries).
    async function runScenario(mode: "linear" | "act-r") {
      const modePath = join(tmpDir, `${mode}.db`);
      const engine = await MemoryEngine.open({
        database_path: modePath,
        weights: { mode },
      });
      const ids = await seed(engine);
      // Identical forge + query for both modes so the only variable
      // is the scoring function.
      await engine.recall("eliza-memory", { query: "user" });
      await engine.recall("eliza-memory", { query: "user" });
      const results = await engine.recall("eliza-memory", {
        query: "Silver cat",
      });
      engine.close();
      return { results, ids };
    }

    const linear = await runScenario("linear");
    const actR = await runScenario("act-r");

    // Both modes should return the same five ids — association
    // expansion is deterministic given identical link state.
    const linearIds = new Set(linear.results.map((r) => r.memory.id));
    const actRIds = new Set(actR.results.map((r) => r.memory.id));
    expect(actRIds).toEqual(linearIds);

    // Both modes should put the strongest direct match at #1 — either
    // cat-origin (matches "Silver" and "cat") or cat-age (same). We
    // don't care which direct match wins as long as it's one of them,
    // not a dog memory pulled in via association.
    const catDirectIds = new Set([
      linear.ids["cat-origin"],
      linear.ids["cat-age"],
    ]);
    expect(catDirectIds.has(linear.results[0].memory.id)).toBe(true);
    expect(catDirectIds.has(actR.results[0].memory.id)).toBe(true);
  });
});
