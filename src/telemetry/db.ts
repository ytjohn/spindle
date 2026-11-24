import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { applyPragmas, runMigrations } from "../memory/schema";
import { resolveMemoryDbPath } from "../memory/engine";

/**
 * Opens the telemetry DB directly, without a MemoryEngine.
 *
 * Telemetry used to be reachable only through `memoryEngine.getDb()`,
 * which meant `memory.enabled: false` silently disabled it too. That
 * coupling inverted the intent: agents that run without memory usually
 * do so because they are cheap and numerous, and they are exactly the
 * agents whose latency we most need to measure. Before this, in one
 * deployment only 3 of 13 agents recorded a single row.
 *
 * Memory and telemetry want the same file (one shared DB per host, rows
 * scoped by `agent_id`), so path resolution deliberately reuses
 * `resolveMemoryDbPath` — `database_path`, then $SPINDLE_MEMORY_DB, then
 * $XDG_DATA_HOME, then ~/.local/share. A telemetry-only agent that sets
 * `memory.database_path` still lands on the same file as its
 * memory-enabled neighbours.
 *
 * Concurrency: the pragmas set WAL with a 5s busy_timeout, so N spindle
 * processes appending one row per turn is well within what SQLite
 * handles. Writes here are single-row appends on turn end, not
 * transactions held open across a turn.
 *
 * Callers own the returned handle and must close it on shutdown; when a
 * MemoryEngine exists, use its handle instead of calling this.
 */
export function openTelemetryDb(
  config: { database_path?: string } | undefined,
  env: NodeJS.ProcessEnv = process.env,
  agentDir?: string
): { db: Database; path: string } {
  const path = resolveMemoryDbPath(config ?? {}, env, agentDir);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  applyPragmas(db);
  runMigrations(db);
  return { db, path };
}
