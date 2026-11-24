/**
 * Phase 5.1 bulk tombstone suggestion scoring.
 *
 * Pure composite-score logic used by `tools/memory-suggest-tombstones.ts`.
 * Does NOT mutate anything — the tool prints suggestions, a human
 * decides, and the tool only writes when invoked with an explicit
 * `--tombstone <ids>` flag.
 *
 * Composite score:
 *
 *   score = activationWeight * squashActR(log(Σ (now - t_j + scaleMs)^(-d)))
 *         + linkWeight * max(decayedStrength(link) for link in links(id))
 *
 * The ACT-R term captures "this memory is rarely/never accessed";
 * the link term captures "but it is a well-connected hub, don't prune
 * it". Grace period (on `created_at`) and recall-count floor filter
 * out new or genuinely-used memories before the math runs.
 *
 * Sort ascending; bottom `limit` are candidates.
 *
 * Wall-clock caveat: the ACT-R activation term is computed against
 * `now`, so an intermittently-used agent that's been idle for a week
 * sees all of its memories look cold. The bulk tool surfaces the
 * ranking; the human is responsible for knowing "I've been away for
 * a week, ignore this run." Do not build an auto-sweep on top of this
 * function — the whole Phase 5.1 scope decision was that scheduled
 * GC is the wrong shape for this use case.
 */

import type { Memory, Visibility } from "./types";
import { DEFAULT_WEIGHTS, type ScoreWeights } from "./scoring";

export interface SuggestOptions {
  /** Memories newer than `now - graceMs` are never candidates. */
  graceMs: number;
  /** Memories with `recall_count >= protectedRecallCount` are protected. */
  protectedRecallCount: number;
  /** Coefficient on the ACT-R activation term. Default 1.0. */
  activationWeight: number;
  /** Coefficient on the max-decayed-link-strength term. Default 0.5. */
  linkWeight: number;
  /**
   * Visibility classes that should NOT be tombstoned. Default `["shared"]`
   * — shared memories belong to a cross-agent contract and this agent
   * should not unilaterally prune them.
   */
  excludeVisibility: Visibility[];
  /** How many bottom-scored candidates to return. */
  limit: number;
}

export interface SuggestCandidate {
  id: number;
  score: number;
  createdAt: number;
  recallCount: number;
  maxLinkStrength: number;
  accessCount: number;
  visibility: Visibility;
  contentPreview: string;
}

export const DEFAULT_SUGGEST_OPTIONS: SuggestOptions = {
  graceMs: 7 * 24 * 60 * 60 * 1000,
  protectedRecallCount: 3,
  activationWeight: 1.0,
  linkWeight: 0.5,
  excludeVisibility: ["shared"],
  limit: 30,
};

/**
 * Squash an unbounded ACT-R activation log into roughly [0, 1].
 * Local copy of scoring.ts's private helper so this module doesn't
 * need to punch a hole in its exports. Same math (K = 2).
 */
function squashActR(A: number): number {
  const K = 2;
  return 1 / (1 + Math.exp(-A / K));
}

/**
 * Compute the composite activation score for a single memory.
 * Pure: no I/O, no mutation. Exported so tests can exercise the math
 * directly.
 */
export function computeCompositeScore(
  memory: Pick<Memory, "id" | "createdAt">,
  accessHistory: number[] | undefined,
  maxLinkStrength: number,
  options: Pick<SuggestOptions, "activationWeight" | "linkWeight">,
  now: number,
  weights: ScoreWeights = DEFAULT_WEIGHTS
): number {
  const history = accessHistory ?? [];
  let activation = 0;
  if (history.length > 0) {
    let sum = 0;
    for (const t of history) {
      const dt = Math.max(0, now - t) + weights.actR.scaleMs;
      sum += Math.pow(dt, -weights.actR.d);
    }
    if (sum > 0) activation = squashActR(Math.log(sum));
  }
  return (
    options.activationWeight * activation +
    options.linkWeight * Math.max(0, maxLinkStrength)
  );
}

/**
 * Take a set of memories + their access histories + max decayed link
 * strengths, apply the filters, compute composite scores, sort
 * ascending, and return the bottom `limit`.
 *
 * Inputs mirror what the bulk tool fetches from the DB, split out so
 * unit tests can drive the logic without a real engine.
 */
export function pickCandidates(
  memories: Memory[],
  accessHistories: Map<number, number[]>,
  maxLinkStrengths: Map<number, number>,
  options: SuggestOptions,
  now: number,
  weights: ScoreWeights = DEFAULT_WEIGHTS
): SuggestCandidate[] {
  const cutoffCreated = now - options.graceMs;
  const excluded = new Set<Visibility>(options.excludeVisibility);
  const scored: SuggestCandidate[] = [];

  for (const mem of memories) {
    // Grace: too new → never a candidate
    if (mem.createdAt > cutoffCreated) continue;
    // Recall floor: recall_count >= protected → never a candidate
    if (mem.recallCount >= options.protectedRecallCount) continue;
    // Visibility exclusion (shared by default)
    if (excluded.has(mem.visibility)) continue;

    const history = accessHistories.get(mem.id);
    const maxLink = maxLinkStrengths.get(mem.id) ?? 0;
    const score = computeCompositeScore(
      mem,
      history,
      maxLink,
      options,
      now,
      weights
    );

    const preview =
      mem.content.length > 80
        ? mem.content.slice(0, 77) + "..."
        : mem.content;

    scored.push({
      id: mem.id,
      score,
      createdAt: mem.createdAt,
      recallCount: mem.recallCount,
      maxLinkStrength: maxLink,
      accessCount: history?.length ?? 0,
      visibility: mem.visibility,
      contentPreview: preview,
    });
  }

  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, options.limit);
}
