import { describe, it, expect } from "vitest";
import {
  pickCandidates,
  computeCompositeScore,
  DEFAULT_SUGGEST_OPTIONS,
  type SuggestOptions,
} from "../../src/memory/suggest";
import type { Memory, Visibility } from "../../src/memory/types";

const NOW = Date.parse("2026-04-14T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function makeMemory(overrides: Partial<Memory> & { id: number }): Memory {
  return {
    id: overrides.id,
    agentId: overrides.agentId ?? "alice",
    visibility: overrides.visibility ?? "private",
    threadId: overrides.threadId ?? null,
    kind: overrides.kind ?? "semantic",
    content: overrides.content ?? `memory ${overrides.id}`,
    metadata: overrides.metadata ?? null,
    embedding: overrides.embedding ?? null,
    createdAt: overrides.createdAt ?? NOW - 30 * DAY,
    lastRecalledAt: overrides.lastRecalledAt ?? null,
    recallCount: overrides.recallCount ?? 0,
    tombstonedAt: overrides.tombstonedAt ?? null,
    tombstoneReason: overrides.tombstoneReason ?? null,
  };
}

function opts(overrides: Partial<SuggestOptions> = {}): SuggestOptions {
  return { ...DEFAULT_SUGGEST_OPTIONS, ...overrides };
}

describe("computeCompositeScore", () => {
  it("returns 0 when there are no accesses and no links", () => {
    const mem = makeMemory({ id: 1 });
    const score = computeCompositeScore(
      mem,
      [],
      0,
      { activationWeight: 1, linkWeight: 0.5 },
      NOW
    );
    expect(score).toBe(0);
  });

  it("boosts score by linkWeight * maxLinkStrength when a link exists", () => {
    const mem = makeMemory({ id: 1 });
    const base = computeCompositeScore(
      mem,
      [],
      0,
      { activationWeight: 1, linkWeight: 0.5 },
      NOW
    );
    const withLink = computeCompositeScore(
      mem,
      [],
      0.8,
      { activationWeight: 1, linkWeight: 0.5 },
      NOW
    );
    expect(withLink).toBeGreaterThan(base);
    expect(withLink).toBeCloseTo(0.5 * 0.8, 6);
  });

  it("a recent access produces a higher activation than a cold memory", () => {
    const mem = makeMemory({ id: 1 });
    const cold = computeCompositeScore(
      mem,
      [NOW - 60 * DAY], // 60-day-old access only
      0,
      { activationWeight: 1, linkWeight: 0 },
      NOW
    );
    const warm = computeCompositeScore(
      mem,
      [NOW - 60 * DAY, NOW - 1 * 60_000], // plus a 1-minute-old access
      0,
      { activationWeight: 1, linkWeight: 0 },
      NOW
    );
    expect(warm).toBeGreaterThan(cold);
  });
});

describe("pickCandidates — grace period", () => {
  it("excludes memories created inside the grace window", () => {
    const recent = makeMemory({ id: 1, createdAt: NOW - 1 * DAY });
    const old = makeMemory({ id: 2, createdAt: NOW - 30 * DAY });
    const candidates = pickCandidates(
      [recent, old],
      new Map(),
      new Map(),
      opts({ graceMs: 7 * DAY, limit: 10 }),
      NOW
    );
    expect(candidates.map((c) => c.id)).toEqual([2]);
  });

  it("graceMs=0 treats every memory as eligible", () => {
    const a = makeMemory({ id: 1, createdAt: NOW - 60_000 });
    const b = makeMemory({ id: 2, createdAt: NOW - 60 * DAY });
    const candidates = pickCandidates(
      [a, b],
      new Map(),
      new Map(),
      opts({ graceMs: 0, limit: 10 }),
      NOW
    );
    expect(candidates.map((c) => c.id).sort()).toEqual([1, 2]);
  });
});

describe("pickCandidates — recall count floor", () => {
  it("excludes memories with recallCount >= protectedRecallCount", () => {
    const cold = makeMemory({ id: 1, recallCount: 0 });
    const loved = makeMemory({ id: 2, recallCount: 5 });
    const candidates = pickCandidates(
      [cold, loved],
      new Map(),
      new Map(),
      opts({ limit: 10 }),
      NOW
    );
    expect(candidates.map((c) => c.id)).toEqual([1]);
  });

  it("protectedRecallCount=0 protects nothing (all included)", () => {
    const cold = makeMemory({ id: 1, recallCount: 0 });
    const loved = makeMemory({ id: 2, recallCount: 50 });
    const candidates = pickCandidates(
      [cold, loved],
      new Map(),
      new Map(),
      opts({ protectedRecallCount: 0, limit: 10 }),
      NOW
    );
    // Neither survives the floor at 0 — cold has 0 >= 0, loved has 50 >= 0
    expect(candidates).toEqual([]);
  });
});

describe("pickCandidates — visibility exclusion", () => {
  it("excludes shared memories by default", () => {
    const priv = makeMemory({ id: 1, visibility: "private" });
    const shared = makeMemory({ id: 2, visibility: "shared" });
    const candidates = pickCandidates(
      [priv, shared],
      new Map(),
      new Map(),
      opts({ limit: 10 }),
      NOW
    );
    expect(candidates.map((c) => c.id)).toEqual([1]);
  });

  it("can include all visibilities when excludeVisibility is empty", () => {
    const priv = makeMemory({ id: 1, visibility: "private" });
    const shared = makeMemory({ id: 2, visibility: "shared" });
    const candidates = pickCandidates(
      [priv, shared],
      new Map(),
      new Map(),
      opts({ excludeVisibility: [], limit: 10 }),
      NOW
    );
    expect(candidates.map((c) => c.id).sort()).toEqual([1, 2]);
  });
});

describe("pickCandidates — scoring + ordering", () => {
  it("sorts ascending by score (coldest first)", () => {
    const a = makeMemory({ id: 1 });
    const b = makeMemory({ id: 2 });
    const c = makeMemory({ id: 3 });
    const candidates = pickCandidates(
      [a, b, c],
      new Map([
        [1, []],
        [2, [NOW - 1 * 60_000]], // very recent → high activation
        [3, [NOW - 60 * DAY]], // old → low activation
      ]),
      new Map(),
      opts({ limit: 10 }),
      NOW
    );
    // Expected coldest-first order: 1 (no accesses), 3 (old access), 2 (recent)
    expect(candidates.map((c) => c.id)).toEqual([1, 3, 2]);
  });

  it("link weight 0 gives pure activation ordering", () => {
    const hub = makeMemory({ id: 1 });
    const orphan = makeMemory({ id: 2 });
    const candidates = pickCandidates(
      [hub, orphan],
      new Map(),
      new Map([
        [1, 0.9], // hub has a strong link, ignored at λ=0
      ]),
      opts({ linkWeight: 0, limit: 10 }),
      NOW
    );
    // Pure activation: both have zero, so both qualify (equal scores)
    expect(candidates.length).toBe(2);
  });

  it("link weight 0.5 protects a strongly-linked hub from being coldest", () => {
    const hub = makeMemory({ id: 1 });
    const orphan = makeMemory({ id: 2 });
    const candidates = pickCandidates(
      [hub, orphan],
      new Map(),
      new Map([
        [1, 0.9],
        [2, 0.0],
      ]),
      opts({ linkWeight: 0.5, limit: 10 }),
      NOW
    );
    // Orphan (score 0) should sort BEFORE hub (score 0.45)
    expect(candidates.map((c) => c.id)).toEqual([2, 1]);
  });
});

describe("pickCandidates — limit", () => {
  it("caps output at `limit`", () => {
    const mems = Array.from({ length: 10 }, (_, i) => makeMemory({ id: i + 1 }));
    const candidates = pickCandidates(
      mems,
      new Map(),
      new Map(),
      opts({ limit: 3 }),
      NOW
    );
    expect(candidates.length).toBe(3);
  });

  it("handles empty input cleanly", () => {
    const candidates = pickCandidates(
      [],
      new Map(),
      new Map(),
      opts({ limit: 10 }),
      NOW
    );
    expect(candidates).toEqual([]);
  });

  it("returns empty when every memory is inside the grace window", () => {
    const mems = Array.from({ length: 5 }, (_, i) =>
      makeMemory({ id: i + 1, createdAt: NOW - 60_000 })
    );
    const candidates = pickCandidates(
      mems,
      new Map(),
      new Map(),
      opts({ limit: 10 }),
      NOW
    );
    expect(candidates).toEqual([]);
  });
});

describe("pickCandidates — preview content", () => {
  it("truncates long content with an ellipsis", () => {
    const longContent = "x".repeat(150);
    const mem = makeMemory({ id: 1, content: longContent });
    const [candidate] = pickCandidates(
      [mem],
      new Map(),
      new Map(),
      opts({ limit: 10 }),
      NOW
    );
    expect(candidate.contentPreview.length).toBe(80);
    expect(candidate.contentPreview.endsWith("...")).toBe(true);
  });

  it("short content is preserved verbatim", () => {
    const mem = makeMemory({ id: 1, content: "brief" });
    const [candidate] = pickCandidates(
      [mem],
      new Map(),
      new Map(),
      opts({ limit: 10 }),
      NOW
    );
    expect(candidate.contentPreview).toBe("brief");
  });
});
