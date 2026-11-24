#!/usr/bin/env bun
/**
 * Samples vLLM engine load into the `engine_load` table.
 *
 * WHY THIS EXISTS: `context_stats` records how slow an agent's turn was
 * but not why. Its own context growing and the whole fleet saturating
 * one engine look identical from inside a single agent. This process
 * records the engine side on a wall-clock cadence so the two can be
 * told apart by joining on time.
 *
 * WHY A SEPARATE PROCESS, not a probe inside the telemetry recorder:
 *   - every spindle agent would run its own probe, N times the load and
 *     N duplicate rows for one engine
 *   - a per-turn probe only samples at turn boundaries, so a burst that
 *     starts and ends inside one long turn is invisible — precisely the
 *     case worth catching
 *   - it would miss consumers that are not spindle agents (other
 *     services, ad-hoc clients), which contend for the same engine
 *
 * Usage:
 *   bun run tools/engine-load-sampler.ts \
 *     --endpoint gpu1=http://gpu1:8005 \
 *     --endpoint gpu2=http://gpu2:8006 \
 *     [--interval 10] [--db /path/to/memory.db]
 *
 * The DB defaults to the same resolution as the memory engine, so rows
 * land beside context_stats and can be joined without a cross-DB attach.
 */
import { Database } from "bun:sqlite";
import { applyPragmas, runMigrations } from "../src/memory/schema";
import { resolveMemoryDbPath } from "../src/memory/engine";
import { insertEngineLoad } from "../src/telemetry/store";

interface Target {
  name: string;
  url: string;
}

/**
 * Pulls a bare gauge out of Prometheus text format.
 *
 * Deliberately gauges only. vLLM also exports cumulative counters
 * (prefix_cache_queries_total and friends); a single scrape of those
 * gives a lifetime average, NOT the current rate. Reading a counter as
 * if it were an instantaneous value is how the prefix-cache hit rate
 * got misreported as "plateaued at 50%" when it was actually still
 * climbing to 90%. Rates must be derived from successive samples, so
 * counters are stored as-is and differenced at read time, never here.
 */
function gauge(metrics: string, name: string): number | null {
  // `name` may already carry a label matcher (e.g. the waiting_by_reason
  // series), in which case do not append the optional-label group again.
  const hasLabels = name.includes("{");
  const re = new RegExp(
    hasLabels
      ? `^${name}\\s+([0-9.eE+-]+)\\s*$`
      : `^${name}(?:\\{[^}]*\\})?\\s+([0-9.eE+-]+)\\s*$`,
    "m"
  );
  const m = metrics.match(re);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

async function sampleOnce(db: Database, t: Target, timeoutMs = 8000): Promise<void> {
  const sampledAt = Date.now();
  try {
    const res = await fetch(`${t.url}/metrics`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();

    // Metric name verified against two live engines serving different
    // models: it is `vllm:kv_cache_usage_perc`. An earlier
    // guess of `vllm:gpu_cache_usage_perc` silently produced NULLs -- the
    // scrape succeeded, so nothing errored, the column was just always
    // empty. Older vLLM builds do use the gpu_ name, so fall back to it
    // rather than assuming one spelling.
    // Reported as a 0..1 fraction; normalise to percent so the column has
    // exactly one meaning regardless of build.
    let kv = gauge(text, "vllm:kv_cache_usage_perc");
    if (kv === null) kv = gauge(text, "vllm:gpu_cache_usage_perc");
    if (kv !== null && kv <= 1) kv = kv * 100;

    insertEngineLoad(db, {
      sampledAt,
      endpoint: t.name,
      numRunning: gauge(text, "vllm:num_requests_running"),
      numWaiting: gauge(text, "vllm:num_requests_waiting"),
      // Verified present on both engines. Distinguishes a
      // genuinely full engine from scheduler pacing.
      numWaitingCapacity: gauge(
        text,
        'vllm:num_requests_waiting_by_reason\\{[^}]*reason="capacity"[^}]*\\}'
      ),
      kvCachePct: kv,
      prefixHitRate: null, // counter-derived; see gauge() note
      // Phase-decomposed latency. Stored raw as cumulative sum+count
      // pairs; difference consecutive samples for an interval mean.
      // These separate the three causes that feel identical from
      // outside: queue = contention, prefill = prompt too big,
      // decode = model/kernel slow.
      queueTimeSum: gauge(text, "vllm:request_queue_time_seconds_sum"),
      queueTimeCount: gauge(text, "vllm:request_queue_time_seconds_count"),
      prefillTimeSum: gauge(text, "vllm:request_prefill_time_seconds_sum"),
      prefillTimeCount: gauge(text, "vllm:request_prefill_time_seconds_count"),
      decodeTimeSum: gauge(text, "vllm:request_decode_time_seconds_sum"),
      decodeTimeCount: gauge(text, "vllm:request_decode_time_seconds_count"),
    });
  } catch (err) {
    // Record the failure rather than dropping it: a GAP in the series
    // means the sampler was down, a row WITH an error means the engine
    // was unreachable. Conflating those would misattribute an outage.
    insertEngineLoad(db, {
      sampledAt,
      endpoint: t.name,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function parseArgs(argv: string[]) {
  const targets: Target[] = [];
  let intervalSec = 10;
  let dbPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--endpoint") {
      const spec = argv[++i] ?? "";
      const eq = spec.indexOf("=");
      if (eq < 1) throw new Error(`--endpoint expects name=url, got "${spec}"`);
      targets.push({ name: spec.slice(0, eq), url: spec.slice(eq + 1).replace(/\/$/, "") });
    } else if (a === "--interval") {
      intervalSec = Number(argv[++i]);
      if (!Number.isFinite(intervalSec) || intervalSec < 1) {
        throw new Error("--interval must be >= 1 second");
      }
    } else if (a === "--db") {
      dbPath = argv[++i];
    }
  }
  if (targets.length === 0) {
    throw new Error("at least one --endpoint name=url is required");
  }
  return { targets, intervalSec, dbPath };
}

async function main() {
  const { targets, intervalSec, dbPath } = parseArgs(process.argv.slice(2));
  const path = dbPath ?? resolveMemoryDbPath({}, process.env);
  const db = new Database(path, { create: true });
  applyPragmas(db);
  runMigrations(db);

  console.log(`[engine-load] db=${path} interval=${intervalSec}s`);
  for (const t of targets) console.log(`[engine-load] target ${t.name} -> ${t.url}/metrics`);

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    console.log("[engine-load] shutting down");
    try {
      db.close();
    } catch {
      /* already closed */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (!stopping) {
    // Sample every target concurrently so one slow engine does not skew
    // the timestamps of the others in the same tick.
    await Promise.all(targets.map((t) => sampleOnce(db, t)));
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
}

main().catch((err) => {
  console.error("[engine-load] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
