/**
 * tools/memory-suggest-tombstones.ts — Phase 5.1 bulk tombstone
 * suggestion diagnostic. Reads a spindle agent's memory DB, scores
 * every owned memory using the composite ACT-R + link-strength
 * formula from `src/memory/suggest.ts`, and prints a ranked list of
 * candidates for human review.
 *
 * Usage:
 *   bun run tools/memory-suggest-tombstones.ts <agent-dir> [flags]
 *
 * Flags:
 *   --agent <id>          Override the derived agent id (defaults to
 *                          the agent directory basename).
 *   --db <path>           Override the agent.yaml memory DB path.
 *   --limit <N>           How many candidates to show. Default 30.
 *   --grace-days <N>      Grace period in days on created_at. Default 7.
 *   --lambda <F>          Link-strength weight coefficient. Default 0.5.
 *   --protected-recalls <N>
 *                         Memories with recall_count >= N are never
 *                          candidates. Default 3.
 *   --include-shared      Include shared memories in scoring (default:
 *                          excluded so this agent never unilaterally
 *                          tombstones a cross-agent memory).
 *   --tombstone <ids>     Comma-separated ids to actually tombstone.
 *                          Each id must be in the just-computed
 *                          suggestion list; ids not in the list are
 *                          rejected to prevent typo-driven accidents.
 *
 * Output is a table of bottom-scored memories. `--tombstone` commits
 * with reason "manual_review". Restoration is a TypeScript API call
 * (`engine.restoreTombstoned([id])`), deliberately friction-laden.
 *
 * Wall-clock caveat: ACT-R activation is computed against the current
 * wall clock, so an intermittently-used agent returning from a quiet
 * week will see everything look uniformly cold. Factor this in before
 * acting on the list — "I've been away, this ranking is relative but
 * the absolute values are meaningless right now".
 *
 * WARNING: this opens the live agent's memory DB in read-write mode.
 * With `--tombstone` it writes tombstones. Snapshot first if you want
 * a throwaway run:
 *
 *   sqlite3 ~/.local/share/spindle/memory.db ".backup /tmp/snap.db"
 *   bun run tools/memory-suggest-tombstones.ts examples/eliza-memory --db /tmp/snap.db
 */

import { basename } from "path";
import { MemoryEngine } from "../src/memory/engine";
import { loadAgentConfig } from "../src/config/loader";
import {
  pickCandidates,
  DEFAULT_SUGGEST_OPTIONS,
  type SuggestOptions,
  type SuggestCandidate,
} from "../src/memory/suggest";
import type { Visibility } from "../src/memory/types";

interface Args {
  agentDir: string;
  agentIdOverride: string | null;
  dbOverride: string | null;
  limit: number;
  graceDays: number;
  lambda: number;
  protectedRecalls: number;
  includeShared: boolean;
  tombstoneIds: number[];
}

function usage(message?: string): never {
  if (message) console.error(`error: ${message}\n`);
  console.error(
    "Usage: bun run tools/memory-suggest-tombstones.ts <agent-dir> [flags]\n" +
      "  --agent <id>            Override derived agent id\n" +
      "  --db <path>             Override memory DB path\n" +
      "  --limit <N>             Max candidates to show (default 30)\n" +
      "  --grace-days <N>        Grace period on created_at (default 7)\n" +
      "  --lambda <F>            linkWeight coefficient (default 0.5)\n" +
      "  --protected-recalls <N> Recall-count floor (default 3)\n" +
      "  --include-shared        Include shared memories (default: excluded)\n" +
      "  --tombstone <ids>       Comma-separated ids to actually tombstone"
  );
  process.exit(2);
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const positional: string[] = [];
  let agentIdOverride: string | null = null;
  let dbOverride: string | null = null;
  let limit = DEFAULT_SUGGEST_OPTIONS.limit;
  let graceDays = DEFAULT_SUGGEST_OPTIONS.graceMs / (24 * 60 * 60 * 1000);
  let lambda = DEFAULT_SUGGEST_OPTIONS.linkWeight;
  let protectedRecalls = DEFAULT_SUGGEST_OPTIONS.protectedRecallCount;
  let includeShared = false;
  let tombstoneIds: number[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--agent") agentIdOverride = argv[++i] ?? usage("--agent requires a value");
    else if (a === "--db") dbOverride = argv[++i] ?? usage("--db requires a value");
    else if (a === "--limit") limit = parseInt(argv[++i] ?? "", 10);
    else if (a === "--grace-days") graceDays = parseFloat(argv[++i] ?? "");
    else if (a === "--lambda") lambda = parseFloat(argv[++i] ?? "");
    else if (a === "--protected-recalls") protectedRecalls = parseInt(argv[++i] ?? "", 10);
    else if (a === "--include-shared") includeShared = true;
    else if (a === "--tombstone") {
      const raw = argv[++i] ?? usage("--tombstone requires an id list");
      tombstoneIds = raw
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (tombstoneIds.length === 0) usage("--tombstone list was empty or invalid");
    } else if (a === "-h" || a === "--help") usage();
    else positional.push(a);
  }
  if (positional.length !== 1) usage("exactly one <agent-dir> argument is required");

  if (!Number.isFinite(limit) || limit <= 0) usage("--limit must be a positive integer");
  if (!Number.isFinite(graceDays) || graceDays < 0) usage("--grace-days must be ≥ 0");
  if (!Number.isFinite(lambda) || lambda < 0) usage("--lambda must be ≥ 0");
  if (!Number.isFinite(protectedRecalls) || protectedRecalls < 0)
    usage("--protected-recalls must be ≥ 0");

  return {
    agentDir: positional[0],
    agentIdOverride,
    dbOverride,
    limit,
    graceDays,
    lambda,
    protectedRecalls,
    includeShared,
    tombstoneIds,
  };
}

function formatAge(ms: number): string {
  const day = 24 * 60 * 60 * 1000;
  if (ms < day) return `${Math.max(1, Math.round(ms / (60 * 60 * 1000)))}h`;
  return `${Math.round(ms / day)}d`;
}

function padLeft(s: string | number, n: number): string {
  return String(s).padStart(n);
}

function padRight(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function printTable(
  candidates: SuggestCandidate[],
  now: number,
  scanned: number,
  eligible: number,
  options: SuggestOptions
): void {
  console.log(
    `Scanned: ${scanned} memories owned by agent`
  );
  console.log(
    `Eligible (past grace period, recallCount < ${options.protectedRecallCount}, visibility allowed): ${eligible}`
  );
  console.log(
    `Showing bottom ${candidates.length} by composite score ` +
      `(${options.activationWeight}*activation + ${options.linkWeight}*maxLinkStrength)`
  );
  console.log("");

  if (candidates.length === 0) {
    console.log("(no candidates)");
    return;
  }

  const header =
    `${padLeft("rank", 4)}  ` +
    `${padLeft("id", 6)}  ` +
    `${padLeft("score", 7)}  ` +
    `${padLeft("age", 5)}  ` +
    `${padLeft("acc", 4)}  ` +
    `${padLeft("rec", 4)}  ` +
    `${padLeft("link", 5)}  ` +
    `${padRight("vis", 7)}  ` +
    `content`;
  console.log(header);
  console.log("-".repeat(header.length));

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const age = formatAge(now - c.createdAt);
    console.log(
      `${padLeft(i + 1, 4)}  ` +
        `${padLeft(c.id, 6)}  ` +
        `${padLeft(c.score.toFixed(3), 7)}  ` +
        `${padLeft(age, 5)}  ` +
        `${padLeft(c.accessCount, 4)}  ` +
        `${padLeft(c.recallCount, 4)}  ` +
        `${padLeft(c.maxLinkStrength.toFixed(2), 5)}  ` +
        `${padRight(c.visibility, 7)}  ` +
        c.contentPreview
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs();

  // Load the agent config so we can resolve the memory DB path via
  // the same machinery spindle uses at boot.
  const cfg = loadAgentConfig(args.agentDir);
  if (!cfg.success) {
    console.error(`Failed to load agent config: ${cfg.errors.join("; ")}`);
    process.exit(1);
  }
  const memoryCfg = cfg.data.memory ?? {};
  const mergedMemoryCfg = args.dbOverride
    ? { ...memoryCfg, database_path: args.dbOverride }
    : memoryCfg;

  const agentId =
    args.agentIdOverride ?? basename(args.agentDir.replace(/\/$/, ""));

  const engine = await MemoryEngine.open(mergedMemoryCfg, process.env, args.agentDir);
  try {
    engine.registerAgent(agentId);

    const snapshot = engine.gcSnapshot(agentId);
    const scanned = snapshot.memories.length;

    const excludeVisibility: Visibility[] = args.includeShared ? [] : ["shared"];
    const options: SuggestOptions = {
      graceMs: args.graceDays * 24 * 60 * 60 * 1000,
      protectedRecallCount: args.protectedRecalls,
      activationWeight: DEFAULT_SUGGEST_OPTIONS.activationWeight,
      linkWeight: args.lambda,
      excludeVisibility,
      limit: args.limit,
    };

    const now = Date.now();

    // "Eligible" = count that would pass the filters regardless of limit.
    // Compute once with a large limit so we can show the ratio.
    const allEligible = pickCandidates(
      snapshot.memories,
      snapshot.accessHistories,
      snapshot.maxLinkStrengths,
      { ...options, limit: Number.MAX_SAFE_INTEGER },
      now
    );
    const candidates = allEligible.slice(0, args.limit);

    console.log(`Agent: ${agentId}`);
    printTable(candidates, now, scanned, allEligible.length, options);

    if (args.tombstoneIds.length > 0) {
      console.log("");
      const candidateIds = new Set(candidates.map((c) => c.id));
      const allowed: number[] = [];
      const rejected: number[] = [];
      for (const id of args.tombstoneIds) {
        if (candidateIds.has(id)) allowed.push(id);
        else rejected.push(id);
      }
      if (rejected.length > 0) {
        console.error(
          `Refusing to tombstone ${rejected.length} id(s) not in the current suggestion list: ${rejected.join(", ")}`
        );
        console.error(
          "Run without --tombstone first to see the list, then pass only listed ids."
        );
      }
      if (allowed.length > 0) {
        const count = engine.tombstone(allowed, "manual_review");
        console.log(
          `Tombstoned ${count} of ${allowed.length} requested memor${allowed.length === 1 ? "y" : "ies"} ` +
            `(reason: manual_review).`
        );
      } else {
        console.log("No ids tombstoned.");
      }
    }
  } finally {
    engine.close();
  }
}

main().catch((err) => {
  console.error("memory-suggest-tombstones failed:", err);
  process.exit(1);
});
