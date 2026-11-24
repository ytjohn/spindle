/**
 * Memory activation scoring.
 *
 * Two pure functions:
 *   - `computeScore` — picks a candidate's recall ranking score. Has
 *     two modes (linear, ACT-R) controlled by `weights.mode`.
 *   - `decayedStrength` — computes the on-read effective strength of a
 *     Hebbian link given its stored strength and last-reinforced
 *     timestamp. Used by `getLinks` and association expansion.
 *
 * The shape is deliberately stable: optional inputs (`cosine`,
 * `link_boost`, `access_history`) are renormalized out of the weight
 * total when absent, so the same function handles every combination of
 * features without a "broken intermediate state".
 */

export interface ScoreInputs {
  /** FTS5 relevance, normalized to [0, 1] by the caller. */
  fts_rank: number;
  /** Unix ms of the last time this memory was returned from a recall. */
  last_recalled_at: number | null;
  /** Total number of times this memory has been returned from recalls. */
  recall_count: number;
  /** Cosine similarity in [-1, 1], or null when either side lacks an embedding. */
  cosine: number | null;
  /**
   * Hebbian association boost in [0, 1]. Non-null only for memories
   * pulled in by association expansion (their decayed link strength
   * relative to the seed); null/absent for direct FTS matches.
   */
  link_boost?: number | null;
  /**
   * Full access history (unix ms timestamps) for this memory. Used
   * only by ACT-R mode. Linear mode ignores it. May be omitted in
   * linear mode to avoid the extra DB read.
   */
  access_history?: number[];
  /** Unix ms of "now" — passed in so the function is pure. */
  now: number;
}

export interface ScoreWeights {
  fts: number;
  recency: number;
  frequency: number;
  /** Ignored when cosine is null (the total weight is renormalized). */
  similarity: number;
  /** Ignored when link_boost is null/absent (renormalized). */
  linkBoost: number;
  /** Recency half-life in ms (linear mode). */
  decayMs: number;
  /** recall_count value at which the frequency term saturates to 1. */
  saturation: number;
  /**
   * Hebbian link decay time constant in ms. Used by `decayedStrength`.
   * This is the e-folding time, not a literal half-life — at
   * `linkHalfLifeMs` ms post-reinforcement, strength has fallen to
   * 1/e ≈ 0.368 of stored. Named for parallelism with `decayMs`,
   * which uses the same e-folding convention.
   */
  linkHalfLifeMs: number;
  /** Scoring mode. `"linear"` is the Phase 2.0 default. */
  mode: "linear" | "act-r";
  /** ACT-R parameters (ignored when mode === "linear"). */
  actR: {
    /** Power-law decay exponent (~0.5 in the literature). */
    d: number;
    /** Time offset added inside the power to avoid t=0 singularities. */
    scaleMs: number;
  };
}

/**
 * Sensible defaults. Exported so callers can spread + override.
 *
 * Recency half-life: 7 days. Frequency saturates at 10 recalls.
 * Hebbian link half-life: 14 days (links live longer than recency
 * because reinforcing them takes deliberate co-activation effort).
 *
 * `linkBoost` defaults to 0.3 — meaningful but not dominant,
 * comparable to recency.
 *
 * Scoring mode defaults to `"linear"` so existing agents stay
 * bit-for-bit unchanged after the Phase 2.1 upgrade. Agents opt into
 * ACT-R via `memory.scoring.mode: "act-r"` in agent.yaml.
 */
export const DEFAULT_WEIGHTS: ScoreWeights = {
  fts: 1.0,
  recency: 0.3,
  frequency: 0.2,
  similarity: 0.5,
  linkBoost: 0.3,
  decayMs: 7 * 24 * 60 * 60 * 1000,
  saturation: 10,
  linkHalfLifeMs: 14 * 24 * 60 * 60 * 1000,
  mode: "linear",
  actR: {
    d: 0.5,
    scaleMs: 1000,
  },
};

/**
 * Compute a memory's activation score for a recall query.
 *
 * Linear mode (default):
 *   weighted sum of fts_rank, recency, frequency, similarity (cosine)
 *   and link_boost. Optional terms (cosine, link_boost) drop out and
 *   the weights renormalize when absent so we never silently average
 *   in a zero.
 *
 * ACT-R mode:
 *   replaces the recency + frequency subterm pair with the true ACT-R
 *   activation summed over `access_history`:
 *
 *     A = log(Σ_j (now - t_j + scaleMs)^(-d))
 *
 *   then squashed to [0, 1] via a logistic. fts, cosine, and
 *   link_boost behave the same as in linear mode. When
 *   `access_history` is missing or empty, the activation term is 0.
 */
export function computeScore(i: ScoreInputs, w: ScoreWeights = DEFAULT_WEIGHTS): number {
  const linkBoost = i.link_boost ?? null;

  if (w.mode === "act-r") {
    return computeScoreActR(i, w, linkBoost);
  }
  return computeScoreLinear(i, w, linkBoost);
}

function computeScoreLinear(
  i: ScoreInputs,
  w: ScoreWeights,
  linkBoost: number | null
): number {
  const recency =
    i.last_recalled_at == null
      ? 0
      : Math.exp(-(i.now - i.last_recalled_at) / w.decayMs);
  const frequency = Math.min(1, i.recall_count / w.saturation);

  // Build the numerator + denominator term-by-term so missing optional
  // inputs cleanly drop out instead of contributing a zero that drags
  // the average down.
  let num = w.fts * i.fts_rank + w.recency * recency + w.frequency * frequency;
  let total = w.fts + w.recency + w.frequency;

  if (i.cosine != null) {
    num += w.similarity * i.cosine;
    total += w.similarity;
  }
  if (linkBoost != null) {
    num += w.linkBoost * linkBoost;
    total += w.linkBoost;
  }

  if (total === 0) return 0;
  return num / total;
}

/**
 * Squash an unbounded ACT-R activation log into roughly [0, 1].
 *
 * `K` controls how aggressively the logistic compresses — K=2 keeps
 * the useful range spread without saturating cheaply. The transform
 * is monotone in `A`, which is the property the ranking actually
 * needs.
 */
function squashActR(A: number): number {
  const K = 2;
  return 1 / (1 + Math.exp(-A / K));
}

function computeScoreActR(
  i: ScoreInputs,
  w: ScoreWeights,
  linkBoost: number | null
): number {
  const history = i.access_history ?? [];
  let activation = 0;
  if (history.length > 0) {
    let sum = 0;
    for (const t of history) {
      const dt = Math.max(0, i.now - t) + w.actR.scaleMs;
      sum += Math.pow(dt, -w.actR.d);
    }
    if (sum > 0) {
      activation = squashActR(Math.log(sum));
    }
  }

  // Reuse the recency + frequency weight budget for the ACT-R term so
  // the two modes are configured the same way — agents don't need a
  // separate `actR` weight.
  const actRWeight = w.recency + w.frequency;

  let num = w.fts * i.fts_rank + actRWeight * activation;
  let total = w.fts + actRWeight;

  if (i.cosine != null) {
    num += w.similarity * i.cosine;
    total += w.similarity;
  }
  if (linkBoost != null) {
    num += w.linkBoost * linkBoost;
    total += w.linkBoost;
  }

  if (total === 0) return 0;
  return num / total;
}

/**
 * Compute the on-read effective strength of a Hebbian link.
 *
 * Stored `strength` is treated as the strength at `lastReinforcedAt`.
 * Reads apply exponential decay against `linkHalfLifeMs` so links
 * weaken over time without any background sweep — persistence and
 * effective strength stay decoupled until something actively
 * reinforces the link.
 *
 * Returns a value in [0, stored_strength]; bumps clamp upward at the
 * call site, not here.
 */
export function decayedStrength(
  link: { strength: number; lastReinforcedAt: number },
  now: number,
  weights: ScoreWeights = DEFAULT_WEIGHTS
): number {
  const dt = Math.max(0, now - link.lastReinforcedAt);
  return link.strength * Math.exp(-dt / weights.linkHalfLifeMs);
}
