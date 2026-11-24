import { describe, it, expect } from "vitest";
import {
  computeScore,
  decayedStrength,
  DEFAULT_WEIGHTS,
  type ScoreInputs,
  type ScoreWeights,
} from "../../src/memory/scoring";

const NOW = 1_700_000_000_000; // fixed "now" for deterministic tests

function inputs(overrides: Partial<ScoreInputs> = {}): ScoreInputs {
  return {
    fts_rank: 0,
    last_recalled_at: null,
    recall_count: 0,
    cosine: null,
    now: NOW,
    ...overrides,
  };
}

describe("computeScore", () => {
  it("returns 0 for an all-zero input with null cosine", () => {
    expect(computeScore(inputs())).toBe(0);
  });

  it("is monotonic in FTS rank (higher rank → higher score)", () => {
    const low = computeScore(inputs({ fts_rank: 0.2 }));
    const high = computeScore(inputs({ fts_rank: 0.8 }));
    expect(high).toBeGreaterThan(low);
  });

  it("recency term is 0 for never-recalled memories", () => {
    const never = computeScore(inputs({ last_recalled_at: null }));
    const notFresh = computeScore(
      inputs({ last_recalled_at: NOW - DEFAULT_WEIGHTS.decayMs * 10 })
    );
    // Both should have a 0 recency contribution but notFresh has a tiny
    // positive value from exp(-10) ≈ 0.000045; they differ by that.
    expect(never).toBeLessThanOrEqual(notFresh + 1e-3);
  });

  it("recency term is 1 (max) for just-recalled memories", () => {
    const freshW: ScoreWeights = {
      ...DEFAULT_WEIGHTS,
      fts: 0,
      recency: 1,
      frequency: 0,
      similarity: 0,
      linkBoost: 0,
    };
    // Only the recency term contributes; at now === last_recalled_at it should be 1.
    const score = computeScore(inputs({ last_recalled_at: NOW }), freshW);
    expect(score).toBeCloseTo(1, 6);
  });

  it("recency decays exponentially with elapsed time", () => {
    const just = computeScore(inputs({ last_recalled_at: NOW }));
    const day = computeScore(
      inputs({ last_recalled_at: NOW - 24 * 60 * 60 * 1000 })
    );
    const week = computeScore(
      inputs({ last_recalled_at: NOW - 7 * 24 * 60 * 60 * 1000 })
    );
    expect(just).toBeGreaterThan(day);
    expect(day).toBeGreaterThan(week);
  });

  it("frequency is monotonic up to saturation", () => {
    const zero = computeScore(inputs({ recall_count: 0 }));
    const five = computeScore(inputs({ recall_count: 5 }));
    const saturated = computeScore(
      inputs({ recall_count: DEFAULT_WEIGHTS.saturation })
    );
    expect(five).toBeGreaterThan(zero);
    expect(saturated).toBeGreaterThan(five);
  });

  it("frequency saturates — additional recalls past saturation don't help", () => {
    const sat = computeScore(
      inputs({ recall_count: DEFAULT_WEIGHTS.saturation })
    );
    const beyond = computeScore(
      inputs({ recall_count: DEFAULT_WEIGHTS.saturation * 10 })
    );
    expect(beyond).toBeCloseTo(sat, 6);
  });

  it("renormalizes weights when cosine is null (3 terms contribute)", () => {
    // With cosine=null, an FTS rank of 1 and all other terms 0 should give
    // fts_weight / (fts + recency + frequency) — i.e. 1.0 / 1.5 for defaults.
    const score = computeScore(inputs({ fts_rank: 1.0, cosine: null }));
    const expected =
      DEFAULT_WEIGHTS.fts /
      (DEFAULT_WEIGHTS.fts + DEFAULT_WEIGHTS.recency + DEFAULT_WEIGHTS.frequency);
    expect(score).toBeCloseTo(expected, 6);
  });

  it("renormalizes weights when cosine is present (4 terms contribute)", () => {
    // With cosine=0, same FTS rank should produce fts / (total including similarity).
    const score = computeScore(inputs({ fts_rank: 1.0, cosine: 0 }));
    const expected =
      DEFAULT_WEIGHTS.fts /
      (DEFAULT_WEIGHTS.fts +
        DEFAULT_WEIGHTS.recency +
        DEFAULT_WEIGHTS.frequency +
        DEFAULT_WEIGHTS.similarity);
    expect(score).toBeCloseTo(expected, 6);
  });

  it("cosine=1 gives a strictly higher score than cosine=0 at otherwise-equal inputs", () => {
    const zero = computeScore(inputs({ fts_rank: 0.5, cosine: 0 }));
    const one = computeScore(inputs({ fts_rank: 0.5, cosine: 1 }));
    expect(one).toBeGreaterThan(zero);
  });

  it("accepts custom weights and uses them", () => {
    const onlyFts: ScoreWeights = { ...DEFAULT_WEIGHTS, recency: 0, frequency: 0, similarity: 0 };
    // With recency/frequency/similarity at 0, score is just fts_rank (renormalized to 1).
    const score = computeScore(inputs({ fts_rank: 0.42, cosine: null }), onlyFts);
    expect(score).toBeCloseTo(0.42, 6);
  });

  it("handles zero total weights without NaN", () => {
    const allZero: ScoreWeights = {
      ...DEFAULT_WEIGHTS,
      fts: 0,
      recency: 0,
      frequency: 0,
      similarity: 0,
      linkBoost: 0,
    };
    const withCos = computeScore(inputs({ cosine: 0.5 }), allZero);
    const withoutCos = computeScore(inputs({ cosine: null }), allZero);
    expect(withCos).toBe(0);
    expect(withoutCos).toBe(0);
  });
});

describe("computeScore — link_boost (Phase 2.1)", () => {
  it("link_boost null/absent renormalizes the same way cosine does", () => {
    // With link_boost absent, the four-term denominator should match
    // the existing cosine-only renormalization.
    const score = computeScore(inputs({ fts_rank: 1.0, cosine: 0 }));
    const expected =
      DEFAULT_WEIGHTS.fts /
      (DEFAULT_WEIGHTS.fts +
        DEFAULT_WEIGHTS.recency +
        DEFAULT_WEIGHTS.frequency +
        DEFAULT_WEIGHTS.similarity);
    expect(score).toBeCloseTo(expected, 6);
  });

  it("link_boost = 1 strictly raises the score above link_boost = null", () => {
    const without = computeScore(inputs({ fts_rank: 0.5, cosine: 0 }));
    const with1 = computeScore(inputs({ fts_rank: 0.5, cosine: 0, link_boost: 1 }));
    expect(with1).toBeGreaterThan(without);
  });

  it("link_boost is monotonic", () => {
    const low = computeScore(inputs({ fts_rank: 0.5, link_boost: 0.1 }));
    const mid = computeScore(inputs({ fts_rank: 0.5, link_boost: 0.5 }));
    const high = computeScore(inputs({ fts_rank: 0.5, link_boost: 1.0 }));
    expect(mid).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(mid);
  });

  it("link_boost present without cosine uses 4 of 5 terms (not 5)", () => {
    // fts_rank = 1, link_boost = 1, no cosine → numerator =
    // fts + linkBoost; denominator = fts + recency + frequency + linkBoost.
    const score = computeScore(
      inputs({ fts_rank: 1, cosine: null, link_boost: 1 })
    );
    const expected =
      (DEFAULT_WEIGHTS.fts + DEFAULT_WEIGHTS.linkBoost) /
      (DEFAULT_WEIGHTS.fts +
        DEFAULT_WEIGHTS.recency +
        DEFAULT_WEIGHTS.frequency +
        DEFAULT_WEIGHTS.linkBoost);
    expect(score).toBeCloseTo(expected, 6);
  });
});

describe("computeScore — ACT-R mode (Phase 2.1)", () => {
  const actR: ScoreWeights = { ...DEFAULT_WEIGHTS, mode: "act-r" };

  it("treats empty access_history as zero activation", () => {
    const empty = computeScore(inputs({ fts_rank: 0, access_history: [] }), actR);
    const omitted = computeScore(inputs({ fts_rank: 0 }), actR);
    expect(empty).toBe(omitted);
    // Only fts contributes to the numerator (which is 0); result is 0.
    expect(empty).toBe(0);
  });

  it("activation is monotone in number of accesses (more recalls → higher)", () => {
    const t = NOW - 60_000; // 1 minute ago
    const one = computeScore(
      inputs({ fts_rank: 0, access_history: [t] }),
      actR
    );
    const five = computeScore(
      inputs({ fts_rank: 0, access_history: [t, t, t, t, t] }),
      actR
    );
    const fifty = computeScore(
      inputs({ fts_rank: 0, access_history: Array(50).fill(t) }),
      actR
    );
    expect(five).toBeGreaterThan(one);
    expect(fifty).toBeGreaterThan(five);
  });

  it("activation is monotone in recency of most recent access", () => {
    const recent = NOW - 60_000; // 1 min ago
    const old = NOW - 30 * 24 * 60 * 60 * 1000; // 30 days ago
    const recentScore = computeScore(
      inputs({ fts_rank: 0, access_history: [recent] }),
      actR
    );
    const oldScore = computeScore(
      inputs({ fts_rank: 0, access_history: [old] }),
      actR
    );
    expect(recentScore).toBeGreaterThan(oldScore);
  });

  it("ACT-R produces finite, sane scores in [0, 1.2]", () => {
    const recent = NOW - 1000;
    const cases = [
      [recent],
      [recent, recent - 5_000, recent - 60_000],
      Array(100).fill(recent),
    ];
    for (const history of cases) {
      const s = computeScore(
        inputs({ fts_rank: 0.5, access_history: history }),
        actR
      );
      expect(Number.isFinite(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1.2);
    }
  });

  it("linear and act-r modes can produce different rankings on the same corpus", () => {
    // Memory A: weak FTS (0.2) but lots of recent accesses
    // Memory B: strong FTS (0.9) but only one ancient access
    const recent = NOW - 5_000;
    const ancient = NOW - 60 * 24 * 60 * 60 * 1000; // 60 days ago

    const aLinearInputs: ScoreInputs = inputs({
      fts_rank: 0.2,
      last_recalled_at: recent,
      recall_count: 10,
      access_history: Array(10).fill(recent),
    });
    const bLinearInputs: ScoreInputs = inputs({
      fts_rank: 0.9,
      last_recalled_at: ancient,
      recall_count: 1,
      access_history: [ancient],
    });

    const aLinear = computeScore(aLinearInputs, DEFAULT_WEIGHTS);
    const bLinear = computeScore(bLinearInputs, DEFAULT_WEIGHTS);
    const aActR = computeScore(aLinearInputs, actR);
    const bActR = computeScore(bLinearInputs, actR);

    // Both modes give finite, non-NaN results.
    expect(Number.isFinite(aLinear)).toBe(true);
    expect(Number.isFinite(bLinear)).toBe(true);
    expect(Number.isFinite(aActR)).toBe(true);
    expect(Number.isFinite(bActR)).toBe(true);

    // The two modes must compute genuinely different scores for at
    // least one of the memories — that's the whole point of having two
    // modes. The exact direction depends on calibration choices in the
    // squashing transform; we just verify the modes are not equivalent.
    const aDifferent = Math.abs(aActR - aLinear) > 1e-6;
    const bDifferent = Math.abs(bActR - bLinear) > 1e-6;
    expect(aDifferent || bDifferent).toBe(true);
  });
});

describe("decayedStrength (Phase 2.1)", () => {
  it("returns the stored strength at t=0 (just reinforced)", () => {
    const link = { strength: 0.5, lastReinforcedAt: NOW };
    expect(decayedStrength(link, NOW)).toBeCloseTo(0.5, 6);
  });

  it("decays to 1/e of stored strength after one e-folding time", () => {
    // linkHalfLifeMs is an e-folding time constant (matches decayMs
    // convention), not a literal half-life. At that distance the value
    // is stored * 1/e ≈ stored * 0.3679.
    const link = {
      strength: 0.5,
      lastReinforcedAt: NOW - DEFAULT_WEIGHTS.linkHalfLifeMs,
    };
    expect(decayedStrength(link, NOW)).toBeCloseTo(0.5 / Math.E, 6);
  });

  it("decays towards zero for very old links", () => {
    const link = {
      strength: 0.9,
      lastReinforcedAt: NOW - DEFAULT_WEIGHTS.linkHalfLifeMs * 20,
    };
    expect(decayedStrength(link, NOW)).toBeLessThan(1e-5);
  });

  it("clamps a future timestamp to no decay (treats now < ts as now == ts)", () => {
    const link = { strength: 0.5, lastReinforcedAt: NOW + 60_000 };
    expect(decayedStrength(link, NOW)).toBeCloseTo(0.5, 6);
  });
});
