/**
 * tools/scoring-mode-compare.ts — side-by-side linear vs ACT-R scoring
 * on a real memory DB. Debug/diagnostic utility; not wired into any
 * runtime path.
 *
 * Usage:
 *   bun run tools/scoring-mode-compare.ts "<query>" [--agent <id>] [--db <path>] [--limit <n>]
 *
 * Env / defaults:
 *   --db     $SPINDLE_MEMORY_DB   (or examples/eliza-memory/memory.db)
 *   --agent  eliza-memory
 *   --limit  10
 *
 * WARNING: this opens TWO MemoryEngine instances against the same DB
 * in read-write mode and issues real recalls. Every run:
 *   - writes two memory_accesses rows per returned memory (one per mode)
 *   - bumps recall_count and last_recalled_at
 *   - reinforces Hebbian links for every pair in each mode's top-K
 *
 * If you care about preserving the live agent's DB state, snapshot
 * first with sqlite3's .backup (NOT `cp` — WAL data lives in the
 * sidecar file):
 *
 *   sqlite3 examples/eliza-memory/memory.db ".backup /tmp/snapshot.db"
 *   bun run tools/scoring-mode-compare.ts "..." --db /tmp/snapshot.db
 */

import { MemoryEngine } from "../src/memory/engine";

interface Args {
  query: string;
  dbPath: string;
  agentId: string;
  limit: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const positional: string[] = [];
  let dbPath = process.env.SPINDLE_MEMORY_DB ?? "examples/eliza-memory/memory.db";
  let agentId = "eliza-memory";
  let limit = 10;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") dbPath = argv[++i];
    else if (a === "--agent") agentId = argv[++i];
    else if (a === "--limit") limit = parseInt(argv[++i], 10);
    else positional.push(a);
  }
  if (positional.length === 0) {
    console.error(
      "Usage: bun run tools/scoring-mode-compare.ts \"<query>\" [--agent id] [--db path] [--limit n]"
    );
    process.exit(2);
  }
  return { query: positional.join(" "), dbPath, agentId, limit };
}

function printRanking(
  label: string,
  results: Array<{ memory: { id: number; content: string }; score: number }>
): void {
  console.log(`=== ${label} ===`);
  if (results.length === 0) {
    console.log("(no matches)");
    return;
  }
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const truncated =
      r.memory.content.length > 70
        ? r.memory.content.slice(0, 67) + "..."
        : r.memory.content;
    console.log(
      `${(i + 1).toString().padStart(2)}. id=${r.memory.id}  score=${r.score.toFixed(4)}  ${truncated}`
    );
  }
  console.log("");
}

async function main() {
  const args = parseArgs();
  console.log(`Query: ${JSON.stringify(args.query)}`);
  console.log(`DB:    ${args.dbPath}`);
  console.log(`Agent: ${args.agentId}\n`);

  // Open one engine per mode, both against the same file. WAL keeps
  // them concurrency-safe but they still race on recall mutations —
  // see the WARNING in the file header.
  const linear = await MemoryEngine.open({
    database_path: args.dbPath,
    weights: { mode: "linear" },
  });
  const actR = await MemoryEngine.open({
    database_path: args.dbPath,
    weights: { mode: "act-r" },
  });

  linear.registerAgent(args.agentId);
  actR.registerAgent(args.agentId);

  const linearResults = await linear.recall(args.agentId, {
    query: args.query,
    limit: args.limit,
  });
  const actRResults = await actR.recall(args.agentId, {
    query: args.query,
    limit: args.limit,
  });

  printRanking("LINEAR mode", linearResults);
  printRanking("ACT-R mode", actRResults);

  console.log("=== rank deltas (linear → act-r) ===");
  const linearRank = new Map<number, number>();
  linearResults.forEach((r, i) => linearRank.set(r.memory.id, i + 1));
  for (let i = 0; i < actRResults.length; i++) {
    const r = actRResults[i];
    const linRank = linearRank.get(r.memory.id);
    const arrow =
      linRank == null
        ? "(new)"
        : linRank === i + 1
          ? "(same)"
          : linRank > i + 1
            ? `↑ from #${linRank}`
            : `↓ from #${linRank}`;
    console.log(`id=${r.memory.id}  act-r #${i + 1}  ${arrow}`);
  }

  linear.close();
  actR.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
