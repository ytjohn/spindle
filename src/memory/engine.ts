import { Database } from "bun:sqlite";

/**
 * bun:sqlite types declare `db.run` + `stmt.run` as accepting only
 * positional array bindings, but the runtime happily accepts a
 * $-prefixed-keys object too (and has docs saying so). Wrap the calls
 * in helpers so the type cast lives in one place and our call sites
 * stay clean.
 */
type NamedParams = Record<string, string | number | bigint | boolean | null | Uint8Array>;

function runNamed(db: Database, sql: string, params: NamedParams): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db.run as unknown as (sql: string, params: NamedParams) => void)(sql, params);
}

function queryNamedGet<T>(db: Database, sql: string, params: NamedParams): T | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stmt = db.query(sql) as any;
  return stmt.get(params) ?? null;
}

function queryNamedAll<T>(db: Database, sql: string, params: NamedParams): T[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stmt = db.query(sql) as any;
  return stmt.all(params) as T[];
}
import { dirname, resolve as resolvePath } from "path";
import { mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import { runMigrations, applyPragmas } from "./schema";
import { buildVisibilityClause, type ThreadContext } from "./visibility";
import {
  computeScore,
  decayedStrength,
  DEFAULT_WEIGHTS,
  type ScoreInputs,
  type ScoreWeights,
} from "./scoring";
import {
  blobToEmbedding,
  cosineSimilarity,
  EmbeddingClient,
  embeddingToBlob,
  type EmbeddingProviderConfig,
} from "./embedding";
import type {
  Memory,
  Visibility,
  MemoryKind,
  StoreOptions,
  RecallOptions,
  RecallResult,
  AgentRecord,
  Link,
  LinkWithScore,
  SessionRow,
  EventRow,
  ListResult,
} from "./types";

// Hebbian link tuning constants (Phase 2.1). Match the formulas from
// the Phase 2.0 plan §"Hebbian co-activation (Phase 2.1)".
const LINK_BASE_STRENGTH = 0.1;
const LINK_MAX_STRENGTH = 1.0;
/** Bump applied when a pair co-appears in a recall's top-K. */
const LINK_CO_RECALL_BONUS = 0.05;
/**
 * Bump applied when a caller explicitly asserts a connection via
 * `engine.associate` or the daydream-only `spindle_memory_associate`
 * tool. Larger than the co-recall bonus because intent is stronger
 * evidence than incidental co-activation.
 */
const LINK_ASSOCIATE_BONUS = 0.15;

/**
 * MemoryEngine — the core class that owns the SQLite database and
 * exposes store/recall operations to spindle and to the pi extension.
 *
 * One engine instance per spindle process, shared by:
 *   - the main user-facing pi session (via the spindle-memory extension)
 *   - (future) Phase 5 daydream loops (which spawn their own ephemeral
 *     pi sessions but talk to the same engine)
 *   - (future) direct TypeScript callers like supervisor agents
 *
 * Phase 2.0 scope: store + recall with FTS5 pre-filter + recency/
 * frequency scoring. No embeddings (Task 5 enables them), no Hebbian
 * links (Phase 2.1), no background loops (Phase 5).
 */
export interface MemoryEngineConfig {
  enabled?: boolean;
  database_path?: string;
  /** Optional scoring weight overrides; falls back to DEFAULT_WEIGHTS. */
  weights?: Partial<ScoreWeights>;
  /**
   * Optional embedding provider. If present, `store` computes and
   * persists an embedding for every new memory, and `recall` computes
   * the query embedding and adds cosine similarity to the score.
   * If absent, the engine runs FTS5-only (Phase 2.0 MVP shape).
   */
  embedding?: EmbeddingProviderConfig;
  /**
   * Phase 2.1 association-based recall expansion. After the direct
   * FTS phase, walk outbound links from the top seeds and rescore
   * neighbors with a link_boost contribution so well-connected
   * memories surface even when the query doesn't lexically match.
   */
  association?: {
    /** Default true. */
    enabled?: boolean;
    /** Top-N direct matches used as association seeds. Default 5. */
    seedCount?: number;
    /** Top-M links expanded per seed. Default 3. */
    perSeed?: number;
  };
}

/**
 * Default association expansion settings — mirrors the Phase 2.1 plan.
 */
const DEFAULT_ASSOCIATION = {
  enabled: true,
  seedCount: 5,
  perSeed: 3,
} as const;

interface ResolvedAssociationConfig {
  enabled: boolean;
  seedCount: number;
  perSeed: number;
}

export class MemoryEngine {
  private readonly db: Database;
  private readonly weights: ScoreWeights;
  private readonly embeddingClient: EmbeddingClient | null;
  private readonly association: ResolvedAssociationConfig;
  private closed = false;

  private constructor(
    db: Database,
    weights: ScoreWeights,
    embeddingClient: EmbeddingClient | null,
    association: ResolvedAssociationConfig
  ) {
    this.db = db;
    this.weights = weights;
    this.embeddingClient = embeddingClient;
    this.association = association;
  }

  /**
   * Open (or create) a memory database and return a ready engine.
   * Runs migrations on first open, idempotent on subsequent opens.
   *
   * If `config.embedding` is provided, the engine builds an
   * `EmbeddingClient` and starts computing embeddings on store + recall.
   * Test code can inject a mock via the `embeddingClient` option (not
   * part of the public agent.yaml config — tests only).
   *
   * `agentDir` is used as the base for relative `database_path` values
   * in the config so paths like `./memory.db` resolve next to the
   * agent directory (consistent with `pi.session_dir` and
   * `pi.load_extensions`).
   */
  static async open(
    config: MemoryEngineConfig & { embeddingClient?: EmbeddingClient | null } = {},
    env: NodeJS.ProcessEnv = process.env,
    agentDir?: string
  ): Promise<MemoryEngine> {
    const dbPath = resolveMemoryDbPath(config, env, agentDir);
    ensureParentDir(dbPath);

    const db = new Database(dbPath, { create: true });
    applyPragmas(db);
    runMigrations(db);

    const weights: ScoreWeights = { ...DEFAULT_WEIGHTS, ...(config.weights ?? {}) };

    // Tests pass an explicit client (null to disable). Production flow
    // builds one from the provider config if present.
    let embeddingClient: EmbeddingClient | null = null;
    if ("embeddingClient" in config && config.embeddingClient !== undefined) {
      embeddingClient = config.embeddingClient;
    } else if (config.embedding) {
      embeddingClient = new EmbeddingClient(config.embedding);
    }

    const association: ResolvedAssociationConfig = {
      ...DEFAULT_ASSOCIATION,
      ...(config.association ?? {}),
    };

    return new MemoryEngine(db, weights, embeddingClient, association);
  }

  /** Whether embeddings are enabled (for diagnostics/tests). */
  get hasEmbeddings(): boolean {
    return this.embeddingClient !== null;
  }

  /**
   * Expose the underlying bun:sqlite handle to adjacent subsystems that
   * project into the same DB file (currently the Phase 4.4 InboxEngine).
   * Deliberately narrow: callers that just want to store/recall memories
   * should go through the typed methods on this class; only projection
   * engines that own their own table namespace should reach for raw SQL.
   */
  getDb(): Database {
    this.assertOpen();
    return this.db;
  }

  /**
   * Close the underlying database. Subsequent calls throw.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // Checkpoint failure shouldn't block close — the DB might already be
      // in an unusual state. Better to close than leak a handle.
    }
    this.db.close();
  }

  /**
   * Register an agent, or update its `last_seen_at` if it already exists.
   * Every memory must reference a valid agent (FK constraint), so
   * spindle calls this at boot before any store/recall.
   */
  registerAgent(id: string, displayName?: string): AgentRecord {
    const now = Date.now();
    runNamed(
      this.db,
      `INSERT INTO agents (id, display_name, created_at, last_seen_at)
       VALUES ($id, $displayName, $createdAt, $lastSeenAt)
       ON CONFLICT(id) DO UPDATE SET
         display_name = COALESCE(excluded.display_name, agents.display_name),
         last_seen_at = excluded.last_seen_at`,
      {
        $id: id,
        $displayName: displayName ?? null,
        $createdAt: now,
        $lastSeenAt: now,
      }
    );
    const row = queryNamedGet<{
      id: string;
      display_name: string | null;
      created_at: number;
      last_seen_at: number;
    }>(
      this.db,
      `SELECT id, display_name, created_at, last_seen_at FROM agents WHERE id = $id`,
      { $id: id }
    )!;
    return {
      id: row.id,
      displayName: row.display_name,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    };
  }

  /**
   * Store a new memory and return its id. Defaults:
   *   - visibility: 'private'
   *   - kind: 'semantic'
   *
   * If an embedding client is configured, this computes and persists
   * the embedding for `content` before writing the row. Failures from
   * the embedding client abort the store — we don't silently drop the
   * signal. Callers that want best-effort storage can catch and retry
   * without the embedding.
   */
  async store(agentId: string, options: StoreOptions): Promise<number> {
    this.assertOpen();
    const visibility: Visibility = options.visibility ?? "private";
    const kind: MemoryKind = options.kind ?? "semantic";
    const threadId = options.threadId ?? null;
    if (visibility === "thread" && !threadId) {
      throw new Error("store: visibility='thread' requires threadId");
    }
    const metadata = options.metadata == null ? null : JSON.stringify(options.metadata);

    let embeddingBlob: Buffer | null = null;
    if (this.embeddingClient) {
      const vec = await this.embeddingClient.embed(options.content);
      embeddingBlob = embeddingToBlob(vec);
    }

    // Use prepared statement to get lastInsertRowid via the Statement's run()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stmt = this.db.query(
      `INSERT INTO memories (
         agent_id, visibility, thread_id, kind, content, metadata, embedding,
         created_at, last_recalled_at, recall_count
       )
       VALUES (
         $agentId, $visibility, $threadId, $kind, $content, $metadata, $embedding,
         $createdAt, NULL, 0
       )`
    ) as any;
    const createdAt = Date.now();
    const result = stmt.run({
      $agentId: agentId,
      $visibility: visibility,
      $threadId: threadId,
      $kind: kind,
      $content: options.content,
      $metadata: metadata,
      $embedding: embeddingBlob,
      $createdAt: createdAt,
    });
    const id = Number(result.lastInsertRowid);

    // Phase 2.1: every memory gets a synthetic initial access row at
    // its creation time. ACT-R scoring sums activation over all access
    // rows, and a never-recalled-but-just-stored memory should still
    // have a well-defined activation. Linear mode also writes the row
    // so a future flip to scoring.mode: "act-r" works without a backfill.
    this.recordAccess(id, createdAt);

    return id;
  }

  /**
   * Recall memories visible to `agentId` that match the query.
   *
   * Pipeline:
   *   1. FTS5 MATCH on `memories_fts` returns candidate rowids + bm25 rank
   *   2. Join back to `memories` and apply the visibility clause
   *   3. When embeddings are enabled, compute the query embedding once
   *      and compute cosine similarity for each candidate that has a
   *      stored embedding
   *   4. Score each candidate with `computeScore` (cosine is null for
   *      memories that lack an embedding OR when embeddings are disabled)
   *   5. Sort by score, take top `limit`
   *   6. Bump `recall_count` and `last_recalled_at` on the returned set
   */
  async recall(agentId: string, options: RecallOptions): Promise<RecallResult[]> {
    this.assertOpen();
    const limit = options.limit ?? 10;
    const now = Date.now();
    const thread: ThreadContext =
      options.threadId != null
        ? { id: options.threadId }
        : options.threadPattern != null
          ? { pattern: options.threadPattern }
          : undefined;

    const vis = buildVisibilityClause(agentId, thread);
    const escaped = escapeFtsQuery(options.query);
    // Empty query (all punctuation / whitespace) → no matches
    if (escaped === "") return [];

    // Pull a generous candidate set (4x the requested limit) so scoring
    // has room to reorder. Minimum 40 so limit=1 still gets context.
    const candidateCap = Math.max(40, limit * 4);

    const rows = queryNamedAll<RawMemoryRow & { bm25_rank: number }>(
      this.db,
      `SELECT
         m.id, m.agent_id, m.visibility, m.thread_id, m.kind,
         m.content, m.metadata, m.embedding, m.created_at,
         m.last_recalled_at, m.recall_count,
         bm25(memories_fts) AS bm25_rank
       FROM memories_fts
       JOIN memories m ON m.id = memories_fts.rowid
       WHERE memories_fts MATCH $query
         AND ${vis.clause}
       ORDER BY bm25_rank
       LIMIT $cap`,
      {
        ...vis.params,
        $query: escaped,
        $cap: candidateCap,
      }
    );

    if (rows.length === 0) return [];

    // Normalize bm25 ranks to [0, 1]. bm25() returns NEGATIVE values in
    // SQLite's FTS5 (best = most negative) so we flip and scale.
    // When there's only one candidate (or all candidates share a rank),
    // assign fts_rank = 1 — they all matched equally well, scoring
    // should reflect that rather than dividing to zero.
    const rawRanks = rows.map((r) => -r.bm25_rank);
    const minRank = Math.min(...rawRanks);
    const maxRank = Math.max(...rawRanks);
    const range = maxRank - minRank;
    const singleOrTied = range === 0;

    // If embeddings are enabled, compute the query embedding once and
    // reuse it across all candidates. Candidates without a stored
    // embedding (legacy rows) get cosine=null and fall back to
    // FTS+recency+frequency scoring transparently.
    let queryEmbedding: Float32Array | null = null;
    if (this.embeddingClient) {
      queryEmbedding = await this.embeddingClient.embed(options.query);
    }

    // Phase 2.1: in ACT-R mode the scoring function needs the full
    // access history for each candidate. Fetch all of them in a single
    // round trip, group in memory by memory_id, then pass each
    // candidate's history into computeScore. Linear mode skips this
    // entirely so existing FTS-only agents pay zero extra cost.
    const historyMap =
      this.weights.mode === "act-r"
        ? this.fetchAccessHistories(rows.map((r) => r.id))
        : null;

    const scored: RecallResult[] = rows.map((row, idx) => {
      const normRank = singleOrTied ? 1 : (rawRanks[idx] - minRank) / range;
      let cosine: number | null = null;
      if (queryEmbedding) {
        const memVec = blobToEmbedding(row.embedding);
        if (memVec) cosine = cosineSimilarity(queryEmbedding, memVec);
      }
      const inputs: ScoreInputs = {
        fts_rank: normRank,
        last_recalled_at: row.last_recalled_at,
        recall_count: row.recall_count,
        cosine,
        access_history: historyMap?.get(row.id),
        now,
      };
      return {
        memory: rowToMemory(row),
        score: computeScore(inputs, this.weights),
      };
    });

    scored.sort((a, b) => b.score - a.score);

    // Phase 2.1: association-based recall expansion. Walk Hebbian
    // links from the top-N direct seeds, fetch their visible
    // neighbors, score them with link_boost = strongest decayed link
    // strength from any seed, then merge the union and re-sort.
    // Direct matches almost always outrank associations (they have a
    // real fts_rank, associations have 0), but well-connected
    // memories can still surface even when they don't lexically match.
    let merged = scored;
    if (this.association.enabled && scored.length > 0) {
      const seeds = scored.slice(0, this.association.seedCount);
      const directIds = new Set(scored.map((s) => s.memory.id));
      const neighborMaxBoost = new Map<number, number>();

      for (const seed of seeds) {
        const seedLinks = this.getLinks(agentId, seed.memory.id, {
          now,
          thread,
        });
        for (const link of seedLinks.slice(0, this.association.perSeed)) {
          const neighborId =
            link.srcId === seed.memory.id ? link.dstId : link.srcId;
          if (directIds.has(neighborId)) continue;
          const prev = neighborMaxBoost.get(neighborId) ?? 0;
          if (link.effectiveStrength > prev) {
            neighborMaxBoost.set(neighborId, link.effectiveStrength);
          }
        }
      }

      if (neighborMaxBoost.size > 0) {
        const neighborIds = Array.from(neighborMaxBoost.keys());
        const neighbors = this.fetchMemoriesByIds(agentId, neighborIds, thread);
        const neighborHistoryMap =
          this.weights.mode === "act-r"
            ? this.fetchAccessHistories(neighborIds)
            : null;

        const associatedScored: RecallResult[] = neighbors.map((mem) => {
          let cosine: number | null = null;
          if (queryEmbedding && mem.embedding) {
            cosine = cosineSimilarity(queryEmbedding, mem.embedding);
          }
          const inputs: ScoreInputs = {
            // Association candidates have no FTS match by definition.
            fts_rank: 0,
            last_recalled_at: mem.lastRecalledAt,
            recall_count: mem.recallCount,
            cosine,
            link_boost: neighborMaxBoost.get(mem.id) ?? 0,
            access_history: neighborHistoryMap?.get(mem.id),
            now,
          };
          return {
            memory: mem,
            score: computeScore(inputs, this.weights),
          };
        });

        merged = scored.concat(associatedScored);
        merged.sort((a, b) => b.score - a.score);
      }
    }

    const top = merged.slice(0, limit);

    // Bump recall bookkeeping on the returned set in a single
    // transaction. Phase 2.1 also writes one memory_accesses row per
    // returned memory at `now`; both linear and act-r modes do this so
    // mode switching never needs a backfill.
    if (top.length > 0) {
      const ids = top.map((r) => r.memory.id);
      const placeholders = ids.map(() => "?").join(",");
      this.db.transaction(() => {
        this.db.run(
          `UPDATE memories
           SET last_recalled_at = ?,
               recall_count = recall_count + 1
           WHERE id IN (${placeholders})`,
          [now, ...ids]
        );
        for (const id of ids) {
          this.recordAccess(id, now);
        }
        // Phase 2.1: Hebbian co-recall reinforcement. Every unordered
        // pair in the returned set gets its link strength bumped.
        // Pairs are stored canonically (min, max) so (a,b) and (b,a)
        // collapse onto one row.
        if (ids.length >= 2) {
          this.reinforceLinks(ids, now, LINK_CO_RECALL_BONUS);
        }
      })();
      // Reflect the bump in the returned objects so callers see fresh values.
      for (const r of top) {
        r.memory.lastRecalledAt = now;
        r.memory.recallCount += 1;
      }
    }

    return top;
  }

  /**
   * Insert a single memory_accesses row. Used by `store()` (synthetic
   * initial access) and `recall()` (one row per returned memory).
   * Cheap enough that we don't bother with prepared-statement caching;
   * if this becomes a hotspot we can add one.
   */
  private recordAccess(memoryId: number, accessedAt: number): void {
    runNamed(
      this.db,
      `INSERT INTO memory_accesses (memory_id, accessed_at)
       VALUES ($memoryId, $accessedAt)`,
      { $memoryId: memoryId, $accessedAt: accessedAt }
    );
  }

  /**
   * Upsert Hebbian links for every unordered pair in `ids`. Caller is
   * responsible for the surrounding transaction. New links start at
   * LINK_BASE_STRENGTH and existing links are bumped by `bonus`,
   * capped at LINK_MAX_STRENGTH. last_reinforced_at is always set to
   * `now`.
   *
   * `ids` does NOT need to be sorted — we canonicalize each pair to
   * (min, max) so the underlying primary key (src_id, dst_id) stays
   * unique and (a,b)/(b,a) collapse to one row.
   *
   * Visibility is enforced by the caller, not here: this helper trusts
   * that whoever assembled `ids` already filtered by what the agent
   * could see.
   */
  private reinforceLinks(ids: number[], now: number, bonus: number): void {
    if (ids.length < 2) return;
    const sql = `
      INSERT INTO links (src_id, dst_id, strength, created_at, last_reinforced_at)
      VALUES ($src, $dst, $base, $now, $now)
      ON CONFLICT(src_id, dst_id) DO UPDATE SET
        strength = MIN($max, links.strength + $bonus),
        last_reinforced_at = excluded.last_reinforced_at
    `;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i];
        const b = ids[j];
        if (a === b) continue;
        const src = Math.min(a, b);
        const dst = Math.max(a, b);
        runNamed(this.db, sql, {
          $src: src,
          $dst: dst,
          $base: LINK_BASE_STRENGTH,
          $now: now,
          $bonus: bonus,
          $max: LINK_MAX_STRENGTH,
        });
      }
    }
  }

  /**
   * Get all Hebbian links touching a memory (either direction),
   * annotated with their decayed effective strength as of `now`.
   * Sorted by effective strength descending so callers can take a
   * top-N slice for association expansion.
   *
   * Honors caller visibility: links are only returned when the
   * neighbor memory is also visible to `agentId` (with optional
   * thread context). This keeps association expansion from leaking
   * across agents.
   */
  getLinks(
    agentId: string,
    memoryId: number,
    options: { now?: number; thread?: ThreadContext } = {}
  ): LinkWithScore[] {
    this.assertOpen();
    const now = options.now ?? Date.now();
    const vis = buildVisibilityClause(agentId, options.thread);
    // Walk both directions: this memory could appear as src or dst.
    // Project the neighbor id as `neighbor_id` so the visibility
    // clause (which references agent_id from `memories`) joins cleanly.
    const rows = queryNamedAll<{
      src_id: number;
      dst_id: number;
      strength: number;
      created_at: number;
      last_reinforced_at: number;
    }>(
      this.db,
      `SELECT l.src_id, l.dst_id, l.strength, l.created_at, l.last_reinforced_at
       FROM links l
       JOIN memories m ON m.id = CASE WHEN l.src_id = $self THEN l.dst_id ELSE l.src_id END
       WHERE (l.src_id = $self OR l.dst_id = $self)
         AND ${vis.clause}`,
      { ...vis.params, $self: memoryId }
    );

    return rows
      .map((r) => {
        const link: Link = {
          srcId: r.src_id,
          dstId: r.dst_id,
          strength: r.strength,
          createdAt: r.created_at,
          lastReinforcedAt: r.last_reinforced_at,
        };
        return {
          ...link,
          effectiveStrength: decayedStrength(link, now, this.weights),
        } satisfies LinkWithScore;
      })
      .sort((a, b) => b.effectiveStrength - a.effectiveStrength);
  }

  /**
   * Persist the current decayed strength of every link as the new
   * stored strength, resetting last_reinforced_at to `now`. Idempotent
   * housekeeping — not required for correctness because reads always
   * recompute decay, but useful when Phase 5.1 GC wants to read fresh
   * persisted values for threshold-based pruning.
   *
   * Returns the number of links updated.
   */
  decayLinks(now: number = Date.now()): number {
    this.assertOpen();
    const halfLife = this.weights.linkHalfLifeMs;
    if (halfLife <= 0) return 0;
    const rows = queryNamedAll<{
      src_id: number;
      dst_id: number;
      strength: number;
      last_reinforced_at: number;
    }>(
      this.db,
      `SELECT src_id, dst_id, strength, last_reinforced_at FROM links`,
      {}
    );
    let updated = 0;
    this.db.transaction(() => {
      for (const r of rows) {
        const dt = Math.max(0, now - r.last_reinforced_at);
        const fresh = r.strength * Math.exp(-dt / halfLife);
        runNamed(
          this.db,
          `UPDATE links
           SET strength = $strength,
               last_reinforced_at = $now
           WHERE src_id = $src AND dst_id = $dst`,
          {
            $strength: fresh,
            $now: now,
            $src: r.src_id,
            $dst: r.dst_id,
          }
        );
        updated += 1;
      }
    })();
    return updated;
  }

  /**
   * Explicit Hebbian strengthening: bump links for every unordered
   * pair in `memoryIds` by LINK_ASSOCIATE_BONUS. Used by daydream
   * curation and by the daydream-only `spindle_memory_associate`
   * pi tool.
   *
   * Visibility-checks each id against `agentId` first; pairs that
   * include an unknown or invisible memory are silently skipped (and
   * counted in the return value). Pairs of visible memories are
   * upserted into `links` in a single transaction.
   *
   * Returns: { reinforced: pairs actually bumped, skipped: pairs
   * dropped because at least one memory was invisible/unknown }.
   */
  associate(
    agentId: string,
    memoryIds: number[],
    options: { now?: number; thread?: ThreadContext } = {}
  ): { reinforced: number; skipped: number } {
    this.assertOpen();
    if (memoryIds.length < 2) return { reinforced: 0, skipped: 0 };
    const now = options.now ?? Date.now();

    // Filter to ids that are visible to the caller. Use a Set to dedupe
    // — the caller may have asserted the same id twice and we don't
    // want to count that as a self-pair.
    const unique = Array.from(new Set(memoryIds));
    const visible = unique.filter(
      (id) => this.getById(agentId, id, options.thread) != null
    );

    let reinforced = 0;
    let skipped = 0;
    this.db.transaction(() => {
      for (let i = 0; i < unique.length; i++) {
        for (let j = i + 1; j < unique.length; j++) {
          const a = unique[i];
          const b = unique[j];
          if (a === b) continue;
          if (!visible.includes(a) || !visible.includes(b)) {
            skipped += 1;
            continue;
          }
          this.reinforceLinks([a, b], now, LINK_ASSOCIATE_BONUS);
          reinforced += 1;
        }
      }
    })();

    return { reinforced, skipped };
  }

  /**
   * Batch-fetch full memory rows for a set of ids, applying the
   * caller's visibility clause. Used by association expansion to pull
   * neighbor memories without an N+1 of getById calls. Returns rows in
   * input id order is NOT guaranteed — caller should map by id if
   * order matters.
   */
  private fetchMemoriesByIds(
    agentId: string,
    ids: number[],
    thread?: ThreadContext
  ): Memory[] {
    if (ids.length === 0) return [];
    const vis = buildVisibilityClause(agentId, thread);
    const placeholders = ids.map((_, i) => `$id${i}`).join(",");
    const params: Record<string, string | number> = { ...vis.params };
    ids.forEach((id, i) => {
      params[`$id${i}`] = id;
    });
    const rows = queryNamedAll<RawMemoryRow>(
      this.db,
      `SELECT
         id, agent_id, visibility, thread_id, kind, content, metadata,
         embedding, created_at, last_recalled_at, recall_count
       FROM memories
       WHERE id IN (${placeholders}) AND ${vis.clause}`,
      params
    );
    return rows.map(rowToMemory);
  }

  /**
   * Batch-fetch access histories for a set of memory ids and group by
   * memory_id. Used by ACT-R scoring during recall. Returns a map even
   * for ids with no rows so the caller can use `.get(id)` uniformly.
   */
  private fetchAccessHistories(ids: number[]): Map<number, number[]> {
    const map = new Map<number, number[]>();
    if (ids.length === 0) return map;
    for (const id of ids) map.set(id, []);
    const placeholders = ids.map(() => "?").join(",");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stmt = this.db.query(
      `SELECT memory_id, accessed_at FROM memory_accesses WHERE memory_id IN (${placeholders})`
    ) as any;
    const rows = stmt.all(...ids) as Array<{ memory_id: number; accessed_at: number }>;
    for (const r of rows) {
      const arr = map.get(r.memory_id);
      if (arr) arr.push(r.accessed_at);
    }
    return map;
  }

  /**
   * Fetch a memory by id, respecting the caller's visibility.
   *
   * Pass `thread` if the id belongs to a thread-scoped memory — otherwise
   * thread-visibility memories return null even for their owning agent
   * (by design of the visibility model: thread memories are only visible
   * when the caller declares they're in that thread).
   *
   * Phase 5.1: tombstoned rows are hidden by default. Pass
   * `{ includeTombstoned: true }` for admin / diagnostic callers that
   * need to see them (bulk suggest tool, `listTombstoned`,
   * restoration flows).
   */
  getById(
    agentId: string,
    id: number,
    thread?: ThreadContext,
    options?: { includeTombstoned?: boolean }
  ): Memory | null {
    this.assertOpen();
    const vis = buildVisibilityClause(agentId, thread, {
      includeTombstoned: options?.includeTombstoned,
    });
    const row = queryNamedGet<RawMemoryRow>(
      this.db,
      `SELECT
         id, agent_id, visibility, thread_id, kind, content, metadata,
         embedding, created_at, last_recalled_at, recall_count,
         tombstoned_at, tombstone_reason
       FROM memories
       WHERE id = $id AND ${vis.clause}`,
      { ...vis.params, $id: id }
    );
    return row ? rowToMemory(row) : null;
  }

  /**
   * Tombstone a set of memories. Writes `tombstoned_at` and
   * `tombstone_reason` on rows that are currently active; rows that are
   * already tombstoned are left alone (idempotent).
   *
   * Does NOT visibility-check — the caller is responsible for deciding
   * which ids may be touched. In practice the daydream-only
   * `spindle_memory_forget` tool filters by `getById` before calling
   * this, and the bulk suggest tool operates on agent-owned rows only.
   *
   * Returns the number of rows actually tombstoned by this call.
   */
  tombstone(ids: number[], reason: string, now: number = Date.now()): number {
    this.assertOpen();
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(",");
    // Pre-count instead of trusting db.run().changes: the FTS5 update
    // trigger INSERTs into memories_fts, which bun:sqlite reports as
    // extra changes. We want the count of memories rows transitioning
    // active → tombstoned, not the aggregate of all side-effect writes.
    let updated = 0;
    this.db.transaction(() => {
      const targets = (
        this.db.query(
          `SELECT id FROM memories
           WHERE id IN (${placeholders}) AND tombstoned_at IS NULL`
        ) as unknown as { all(...p: number[]): Array<{ id: number }> }
      ).all(...ids);
      if (targets.length === 0) return;
      this.db.run(
        `UPDATE memories
         SET tombstoned_at = ?, tombstone_reason = ?
         WHERE id IN (${placeholders}) AND tombstoned_at IS NULL`,
        [now, reason, ...ids]
      );
      updated = targets.length;
    })();
    return updated;
  }

  /**
   * Reverse a tombstone. Sets `tombstoned_at` and `tombstone_reason`
   * back to NULL on any rows in `ids` that are currently tombstoned.
   * Idempotent (no-op on already-active rows).
   *
   * TypeScript API only — no LLM tool. Restoration is a deliberate
   * human-driven operation.
   */
  restoreTombstoned(ids: number[]): number {
    this.assertOpen();
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(",");
    let updated = 0;
    this.db.transaction(() => {
      const targets = (
        this.db.query(
          `SELECT id FROM memories
           WHERE id IN (${placeholders}) AND tombstoned_at IS NOT NULL`
        ) as unknown as { all(...p: number[]): Array<{ id: number }> }
      ).all(...ids);
      if (targets.length === 0) return;
      this.db.run(
        `UPDATE memories
         SET tombstoned_at = NULL, tombstone_reason = NULL
         WHERE id IN (${placeholders}) AND tombstoned_at IS NOT NULL`,
        ids
      );
      updated = targets.length;
    })();
    return updated;
  }

  /**
   * List tombstoned memories OWNED by an agent (not visibility-filtered
   * — a shared tombstone belonging to another agent is not surfaced
   * here). Newest-tombstoned first. Used by the bulk suggest tool and
   * any future admin UI.
   */
  listTombstoned(
    agentId: string,
    options: { limit?: number } = {}
  ): Memory[] {
    this.assertOpen();
    const limit = options.limit ?? 100;
    const rows = queryNamedAll<RawMemoryRow>(
      this.db,
      `SELECT
         id, agent_id, visibility, thread_id, kind, content, metadata,
         embedding, created_at, last_recalled_at, recall_count,
         tombstoned_at, tombstone_reason
       FROM memories
       WHERE agent_id = $agentId AND tombstoned_at IS NOT NULL
       ORDER BY tombstoned_at DESC
       LIMIT $limit`,
      { $agentId: agentId, $limit: limit }
    );
    return rows.map(rowToMemory);
  }

  /**
   * List the N most recently created memories visible to `agentId`,
   * newest first. Used by the daydream loop to pass recent context to
   * the memory-curator prompt so the LLM can avoid storing duplicates.
   *
   * Ordering is by `created_at DESC` — NOT by activation score. The
   * daydream wants "what's recently been added", not "what's most
   * relevant", because its job is to decide what NEW things to add.
   */
  listRecent(agentId: string, limit: number, thread?: ThreadContext): Memory[] {
    this.assertOpen();
    const vis = buildVisibilityClause(agentId, thread);
    const rows = queryNamedAll<RawMemoryRow>(
      this.db,
      `SELECT
         id, agent_id, visibility, thread_id, kind, content, metadata,
         embedding, created_at, last_recalled_at, recall_count
       FROM memories
       WHERE ${vis.clause}
       ORDER BY created_at DESC
       LIMIT $limit`,
      { ...vis.params, $limit: limit }
    );
    return rows.map(rowToMemory);
  }

  /**
   * Count memories visible to a given agent. Exposed mostly for tests
   * and diagnostics (`/memory count` style queries in a future admin UI).
   */
  countVisible(agentId: string, thread?: ThreadContext): number {
    this.assertOpen();
    const vis = buildVisibilityClause(agentId, thread);
    const row = queryNamedGet<{ c: number }>(
      this.db,
      `SELECT COUNT(*) AS c FROM memories WHERE ${vis.clause}`,
      vis.params
    );
    return row?.c ?? 0;
  }

  /**
   * Fetch everything the bulk tombstone-suggest tool needs for an
   * agent in one call:
   *   - every active memory owned by `agentId`
   *   - access history grouped by memory id
   *   - max decayed link strength per memory id (touching either src
   *     or dst of a link, whichever is the memory in question)
   *
   * The max-decayed-link-strength map uses the same `decayedStrength`
   * formula recall uses, so the bulk tool's composite score matches
   * what the scoring function would see at read time.
   *
   * Tombstoned rows are excluded (ownership + `tombstoned_at IS NULL`).
   * This is intentional: the tool proposes NEW tombstones, it doesn't
   * re-score ones already dead.
   */
  gcSnapshot(agentId: string): {
    memories: Memory[];
    accessHistories: Map<number, number[]>;
    maxLinkStrengths: Map<number, number>;
  } {
    this.assertOpen();
    const rows = queryNamedAll<RawMemoryRow>(
      this.db,
      `SELECT
         id, agent_id, visibility, thread_id, kind, content, metadata,
         embedding, created_at, last_recalled_at, recall_count,
         tombstoned_at, tombstone_reason
       FROM memories
       WHERE agent_id = $agentId AND tombstoned_at IS NULL
       ORDER BY id ASC`,
      { $agentId: agentId }
    );
    const memories = rows.map(rowToMemory);
    const ids = memories.map((m) => m.id);
    const accessHistories = this.fetchAccessHistories(ids);

    // Max decayed link strength per memory. A memory can appear as
    // src OR dst; we walk the whole links table once and project both
    // directions, keeping the max observed effective strength per id.
    const maxLinkStrengths = new Map<number, number>();
    if (ids.length > 0) {
      const now = Date.now();
      const halfLife = this.weights.linkHalfLifeMs;
      const ownedSet = new Set(ids);
      const linkRows = queryNamedAll<{
        src_id: number;
        dst_id: number;
        strength: number;
        last_reinforced_at: number;
      }>(
        this.db,
        `SELECT src_id, dst_id, strength, last_reinforced_at FROM links`,
        {}
      );
      for (const l of linkRows) {
        const dt = Math.max(0, now - l.last_reinforced_at);
        const effective = halfLife > 0
          ? l.strength * Math.exp(-dt / halfLife)
          : l.strength;
        if (ownedSet.has(l.src_id)) {
          const prev = maxLinkStrengths.get(l.src_id) ?? 0;
          if (effective > prev) maxLinkStrengths.set(l.src_id, effective);
        }
        if (ownedSet.has(l.dst_id)) {
          const prev = maxLinkStrengths.get(l.dst_id) ?? 0;
          if (effective > prev) maxLinkStrengths.set(l.dst_id, effective);
        }
      }
    }

    return { memories, accessHistories, maxLinkStrengths };
  }

  // ==========================================================================
  // Phase 4.1 — session / event ingester primitives
  // ==========================================================================

  /**
   * Upsert a session row. Called by the ingester on discovery and
   * after each successful backfill/poll cycle. Returns the row as it
   * now exists in the DB.
   */
  upsertSession(input: {
    agentId: string;
    id: string;
    filePath: string;
    now?: number;
  }): SessionRow {
    this.assertOpen();
    const now = input.now ?? Date.now();
    runNamed(
      this.db,
      `INSERT INTO sessions (id, agent_id, file_path, created_at, updated_at)
       VALUES ($id, $agentId, $filePath, $now, $now)
       ON CONFLICT(agent_id, id) DO UPDATE SET
         file_path = excluded.file_path,
         updated_at = excluded.updated_at`,
      {
        $id: input.id,
        $agentId: input.agentId,
        $filePath: input.filePath,
        $now: now,
      }
    );
    return this.getSession(input.agentId, input.id)!;
  }

  /**
   * Fetch one session row or null. Used by the ingester (watermark
   * lookup) and by the API `/spindle/sessions/{id}` route.
   */
  getSession(agentId: string, id: string): SessionRow | null {
    this.assertOpen();
    const row = queryNamedGet<RawSessionRow>(
      this.db,
      `SELECT id, agent_id, file_path, started_at, last_activity_at,
              event_count, last_ingested_byte_offset,
              last_ingest_error, last_ingest_error_at,
              created_at, updated_at
         FROM sessions
         WHERE agent_id = $agentId AND id = $id`,
      { $agentId: agentId, $id: id }
    );
    return row ? rowToSessionRow(row) : null;
  }

  /**
   * Insert a batch of events + update the owning session row's
   * watermark + counters atomically. Caller passes projected events
   * (from `parseEventLine`) plus the seq for each. `sessionUpdate`
   * holds the new watermark and event-count delta; `clearError`
   * resets `last_ingest_error` when set.
   */
  appendEvents(input: {
    agentId: string;
    sessionId: string;
    events: Array<{
      seq: number;
      byte_offset: number;
      ts: number | null;
      event_type: string;
      pi_event_id: string | null;
      parent_id: string | null;
      role: string | null;
      model: string | null;
      content_json: string;
      content_text: string | null;
    }>;
    newByteOffset: number;
    newEventCount: number;
    earliestTs: number | null;
    latestTs: number | null;
    now?: number;
    clearError?: boolean;
  }): void {
    this.assertOpen();
    const now = input.now ?? Date.now();
    this.db.transaction(() => {
      for (const e of input.events) {
        runNamed(
          this.db,
          `INSERT INTO events (
             agent_id, session_id, seq, byte_offset, ts, event_type,
             pi_event_id, parent_id, role, model, content_json, content_text
           ) VALUES (
             $agentId, $sessionId, $seq, $byteOffset, $ts, $eventType,
             $piEventId, $parentId, $role, $model, $contentJson, $contentText
           )`,
          {
            $agentId: input.agentId,
            $sessionId: input.sessionId,
            $seq: e.seq,
            $byteOffset: e.byte_offset,
            $ts: e.ts,
            $eventType: e.event_type,
            $piEventId: e.pi_event_id,
            $parentId: e.parent_id,
            $role: e.role,
            $model: e.model,
            $contentJson: e.content_json,
            $contentText: e.content_text,
          }
        );
      }
      runNamed(
        this.db,
        `UPDATE sessions
           SET last_ingested_byte_offset = $offset,
               event_count = $count,
               started_at = COALESCE(started_at, $earliest),
               last_activity_at = CASE
                 WHEN $latest IS NULL THEN last_activity_at
                 WHEN last_activity_at IS NULL OR $latest > last_activity_at THEN $latest
                 ELSE last_activity_at
               END,
               last_ingest_error = CASE WHEN $clearError = 1 THEN NULL ELSE last_ingest_error END,
               last_ingest_error_at = CASE WHEN $clearError = 1 THEN NULL ELSE last_ingest_error_at END,
               updated_at = $now
         WHERE agent_id = $agentId AND id = $sessionId`,
        {
          $offset: input.newByteOffset,
          $count: input.newEventCount,
          $earliest: input.earliestTs,
          $latest: input.latestTs,
          $clearError: input.clearError ? 1 : 0,
          $now: now,
          $agentId: input.agentId,
          $sessionId: input.sessionId,
        }
      );
    })();
  }

  /**
   * Record an ingest error on a session row without advancing the
   * watermark. Used when a line fails to parse or a file read throws.
   */
  recordSessionIngestError(
    agentId: string,
    sessionId: string,
    message: string,
    now: number = Date.now()
  ): void {
    this.assertOpen();
    runNamed(
      this.db,
      `UPDATE sessions
         SET last_ingest_error = $message,
             last_ingest_error_at = $now,
             updated_at = $now
       WHERE agent_id = $agentId AND id = $sessionId`,
      {
        $message: message,
        $now: now,
        $agentId: agentId,
        $sessionId: sessionId,
      }
    );
  }

  // ==========================================================================
  // Phase 4.1 — query surface for the web API
  // ==========================================================================

  listSessions(
    agentId: string,
    options: {
      limit?: number;
      offset?: number;
      since?: number;
      until?: number;
      minEvents?: number;
    } = {}
  ): ListResult<SessionRow> {
    this.assertOpen();
    const { limit, offset } = clampListOptions(options);
    const where: string[] = [`agent_id = $agentId`];
    const params: NamedParams = { $agentId: agentId };
    if (options.since !== undefined) {
      where.push(`(last_activity_at IS NOT NULL AND last_activity_at >= $since)`);
      params.$since = options.since;
    }
    if (options.until !== undefined) {
      where.push(`(last_activity_at IS NOT NULL AND last_activity_at <= $until)`);
      params.$until = options.until;
    }
    if (options.minEvents !== undefined) {
      where.push(`event_count >= $minEvents`);
      params.$minEvents = options.minEvents;
    }
    const whereSql = where.join(" AND ");

    const totalRow = queryNamedGet<{ c: number }>(
      this.db,
      `SELECT COUNT(*) AS c FROM sessions WHERE ${whereSql}`,
      params
    );
    const total = totalRow?.c ?? 0;

    const rows = queryNamedAll<RawSessionRow>(
      this.db,
      `SELECT id, agent_id, file_path, started_at, last_activity_at,
              event_count, last_ingested_byte_offset,
              last_ingest_error, last_ingest_error_at,
              created_at, updated_at
         FROM sessions
         WHERE ${whereSql}
         ORDER BY COALESCE(last_activity_at, created_at) DESC
         LIMIT $limit OFFSET $offset`,
      { ...params, $limit: limit, $offset: offset }
    );

    const items = rows.map(rowToSessionRow);
    return { items, total, limit, offset, hasMore: offset + items.length < total };
  }

  listSessionEvents(
    agentId: string,
    sessionId: string,
    options: {
      limit?: number;
      offset?: number;
      eventTypes?: string[];
      roles?: string[];
      since?: number;
      until?: number;
    } = {}
  ): ListResult<EventRow> {
    return this.queryEvents(agentId, { ...options, sessionId });
  }

  searchEvents(
    agentId: string,
    options: {
      q?: string;
      sessionId?: string;
      limit?: number;
      offset?: number;
      eventTypes?: string[];
      roles?: string[];
      since?: number;
      until?: number;
    } = {}
  ): ListResult<EventRow> {
    return this.queryEvents(agentId, options);
  }

  private queryEvents(
    agentId: string,
    options: {
      q?: string;
      sessionId?: string;
      limit?: number;
      offset?: number;
      eventTypes?: string[];
      roles?: string[];
      since?: number;
      until?: number;
    }
  ): ListResult<EventRow> {
    this.assertOpen();
    const { limit, offset } = clampListOptions(options);
    const where: string[] = [`e.agent_id = $agentId`];
    const params: NamedParams = { $agentId: agentId };
    let useFts = false;
    let joinFts = "";
    let orderBy = `e.ts DESC, e.id DESC`;

    const ftsQuery = options.q ? escapeFtsQuery(options.q) : "";
    if (ftsQuery.length > 0) {
      useFts = true;
      joinFts = `JOIN events_fts f ON f.rowid = e.id`;
      where.push(`events_fts MATCH $fts`);
      params.$fts = ftsQuery;
      orderBy = `rank, e.id DESC`;
    }

    if (options.sessionId !== undefined) {
      where.push(`e.session_id = $sessionId`);
      params.$sessionId = options.sessionId;
    }
    if (options.eventTypes && options.eventTypes.length > 0) {
      const placeholders = options.eventTypes
        .map((_, i) => `$et${i}`)
        .join(", ");
      where.push(`e.event_type IN (${placeholders})`);
      options.eventTypes.forEach((t, i) => {
        params[`$et${i}`] = t;
      });
    }
    if (options.roles && options.roles.length > 0) {
      const placeholders = options.roles
        .map((_, i) => `$r${i}`)
        .join(", ");
      where.push(`e.role IN (${placeholders})`);
      options.roles.forEach((r, i) => {
        params[`$r${i}`] = r;
      });
    }
    if (options.since !== undefined) {
      where.push(`e.ts IS NOT NULL AND e.ts >= $since`);
      params.$since = options.since;
    }
    if (options.until !== undefined) {
      where.push(`e.ts IS NOT NULL AND e.ts <= $until`);
      params.$until = options.until;
    }

    const whereSql = where.join(" AND ");

    const totalRow = queryNamedGet<{ c: number }>(
      this.db,
      `SELECT COUNT(*) AS c FROM events e ${joinFts} WHERE ${whereSql}`,
      params
    );
    const total = totalRow?.c ?? 0;

    // Without FTS, scoped queries go by (session_id, seq ASC) because
    // that's the natural reading order. Global queries go by ts DESC.
    if (!useFts) {
      if (options.sessionId !== undefined) {
        orderBy = `e.seq ASC`;
      }
    }

    const rows = queryNamedAll<RawEventRow>(
      this.db,
      `SELECT e.id, e.agent_id, e.session_id, e.seq, e.byte_offset,
              e.ts, e.event_type, e.pi_event_id, e.parent_id,
              e.role, e.model, e.content_json, e.content_text
         FROM events e
         ${joinFts}
         WHERE ${whereSql}
         ORDER BY ${orderBy}
         LIMIT $limit OFFSET $offset`,
      { ...params, $limit: limit, $offset: offset }
    );

    const items = rows.map(rowToEventRow);
    return { items, total, limit, offset, hasMore: offset + items.length < total };
  }

  /**
   * Web API list surface for memories. Unlike `recall`, this does not
   * rescore or write access log entries — it's a read-only browse
   * suitable for an operator UI. Visibility: the operator sees all
   * rows owned by this agent (the thread-visibility clause doesn't
   * apply to an operator-level inspection).
   */
  listMemories(
    agentId: string,
    options: {
      q?: string;
      kind?: MemoryKind[];
      includeTombstoned?: boolean;
      since?: number;
      until?: number;
      limit?: number;
      offset?: number;
    } = {}
  ): ListResult<Memory> {
    this.assertOpen();
    const { limit, offset } = clampListOptions(options);
    const where: string[] = [`m.agent_id = $agentId`];
    const params: NamedParams = { $agentId: agentId };

    if (!options.includeTombstoned) {
      where.push(`m.tombstoned_at IS NULL`);
    }
    if (options.kind && options.kind.length > 0) {
      const placeholders = options.kind
        .map((_, i) => `$k${i}`)
        .join(", ");
      where.push(`m.kind IN (${placeholders})`);
      options.kind.forEach((k, i) => {
        params[`$k${i}`] = k;
      });
    }
    if (options.since !== undefined) {
      where.push(`m.created_at >= $since`);
      params.$since = options.since;
    }
    if (options.until !== undefined) {
      where.push(`m.created_at <= $until`);
      params.$until = options.until;
    }

    let joinFts = "";
    let orderBy = `m.last_recalled_at DESC NULLS LAST, m.created_at DESC`;
    const ftsQuery = options.q ? escapeFtsQuery(options.q) : "";
    if (ftsQuery.length > 0) {
      joinFts = `JOIN memories_fts mf ON mf.rowid = m.id`;
      where.push(`memories_fts MATCH $fts`);
      params.$fts = ftsQuery;
      orderBy = `rank, m.id DESC`;
    }

    const whereSql = where.join(" AND ");

    const totalRow = queryNamedGet<{ c: number }>(
      this.db,
      `SELECT COUNT(*) AS c FROM memories m ${joinFts} WHERE ${whereSql}`,
      params
    );
    const total = totalRow?.c ?? 0;

    const rows = queryNamedAll<RawMemoryRow>(
      this.db,
      `SELECT m.id, m.agent_id, m.visibility, m.thread_id, m.kind,
              m.content, m.metadata, m.embedding, m.created_at,
              m.last_recalled_at, m.recall_count,
              m.tombstoned_at, m.tombstone_reason
         FROM memories m
         ${joinFts}
         WHERE ${whereSql}
         ORDER BY ${orderBy}
         LIMIT $limit OFFSET $offset`,
      { ...params, $limit: limit, $offset: offset }
    );

    const items = rows.map(rowToMemory);
    return { items, total, limit, offset, hasMore: offset + items.length < total };
  }

  /**
   * Partial update of a memory's mutable fields. Returns the updated
   * Memory, or null if the row doesn't exist or isn't owned by the
   * caller's agent. Validates `visibility === "thread"` requires
   * `thread_id`. Throws on an empty patch (no fields to update).
   *
   * Operator surface — invoked via `PATCH /spindle/memories/{id}`.
   * Does not touch `created_at`, `last_recalled_at`, or `recall_count`.
   * Existing FTS5 update trigger keeps `memories_fts` in sync when
   * `content` changes.
   */
  updateMemory(
    agentId: string,
    id: number,
    fields: {
      content?: string;
      kind?: MemoryKind;
      visibility?: Visibility;
      threadId?: string | null;
      metadata?: Record<string, unknown> | null;
    }
  ): Memory | null {
    this.assertOpen();
    const existing = this.getMemoryById(agentId, id);
    if (!existing) return null;

    const sets: string[] = [];
    const params: NamedParams = { $id: id, $agentId: agentId };

    if (fields.content !== undefined) {
      sets.push("content = $content");
      params.$content = fields.content;
    }
    if (fields.kind !== undefined) {
      sets.push("kind = $kind");
      params.$kind = fields.kind;
    }
    let nextVisibility = existing.visibility;
    let nextThreadId = existing.threadId;
    if (fields.visibility !== undefined) {
      sets.push("visibility = $visibility");
      params.$visibility = fields.visibility;
      nextVisibility = fields.visibility;
    }
    if (fields.threadId !== undefined) {
      sets.push("thread_id = $threadId");
      params.$threadId = fields.threadId;
      nextThreadId = fields.threadId;
    }
    if (fields.metadata !== undefined) {
      sets.push("metadata = $metadata");
      params.$metadata =
        fields.metadata === null ? null : JSON.stringify(fields.metadata);
    }

    if (sets.length === 0) {
      throw new Error("updateMemory called with no fields to update");
    }

    if (nextVisibility === "thread" && !nextThreadId) {
      throw new Error(
        `memory ${id}: visibility=thread requires thread_id to be set`
      );
    }

    runNamed(
      this.db,
      `UPDATE memories SET ${sets.join(", ")}
         WHERE id = $id AND agent_id = $agentId`,
      params
    );
    return this.getMemoryById(agentId, id);
  }

  /**
   * Ownership-checking wrapper around `tombstone`. Returns the
   * tombstoned row or null when the id is unknown / wrong-agent / was
   * already tombstoned. The bulk `tombstone` method stays unchanged
   * for daydream/forget use; this is the API-safe entry point.
   */
  tombstoneScoped(
    agentId: string,
    id: number,
    reason: string,
    now: number = Date.now()
  ): Memory | null {
    this.assertOpen();
    const existing = this.getMemoryById(agentId, id);
    if (!existing || existing.tombstonedAt !== null) return null;
    const count = this.tombstone([id], reason, now);
    if (count === 0) return null;
    return this.getMemoryById(agentId, id);
  }

  /**
   * Ownership-checking wrapper around `restoreTombstoned`. Returns
   * the restored row or null when the id is unknown / wrong-agent /
   * wasn't tombstoned.
   */
  restoreScoped(agentId: string, id: number): Memory | null {
    this.assertOpen();
    const existing = this.getMemoryById(agentId, id);
    if (!existing || existing.tombstonedAt === null) return null;
    const count = this.restoreTombstoned([id]);
    if (count === 0) return null;
    return this.getMemoryById(agentId, id);
  }

  /**
   * Fetch a single memory by id, scoped by agent. Returns null if not
   * found or owned by a different agent.
   */
  getMemoryById(agentId: string, id: number): Memory | null {
    this.assertOpen();
    const row = queryNamedGet<RawMemoryRow>(
      this.db,
      `SELECT id, agent_id, visibility, thread_id, kind, content, metadata,
              embedding, created_at, last_recalled_at, recall_count,
              tombstoned_at, tombstone_reason
         FROM memories
         WHERE agent_id = $agentId AND id = $id`,
      { $agentId: agentId, $id: id }
    );
    return row ? rowToMemory(row) : null;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("MemoryEngine is closed");
  }
}

// ============================================================================
// Helpers
// ============================================================================

interface RawMemoryRow {
  id: number;
  agent_id: string;
  visibility: Visibility;
  thread_id: string | null;
  kind: MemoryKind;
  content: string;
  metadata: string | null;
  embedding: Buffer | null;
  created_at: number;
  last_recalled_at: number | null;
  recall_count: number;
  tombstoned_at?: number | null;
  tombstone_reason?: string | null;
}

function rowToMemory(row: RawMemoryRow): Memory {
  return {
    id: row.id,
    agentId: row.agent_id,
    visibility: row.visibility,
    threadId: row.thread_id,
    kind: row.kind,
    content: row.content,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
    embedding: blobToEmbedding(row.embedding),
    createdAt: row.created_at,
    lastRecalledAt: row.last_recalled_at,
    recallCount: row.recall_count,
    tombstonedAt: row.tombstoned_at ?? null,
    tombstoneReason: row.tombstone_reason ?? null,
  };
}

/**
 * Convert user-supplied text into an FTS5 MATCH expression suitable
 * for keyword-style search.
 *
 * Approach: tokenize on whitespace, keep alphanumerics only (drops
 * punctuation and operator characters like `-`, `.`, `AND`), wrap each
 * token in double-quotes to stop FTS5 from parsing it as an operator
 * even if it happens to spell `AND` / `OR` / `NOT` / `NEAR`, and join
 * with `OR` so a memory matching any of the tokens is a candidate. The
 * bm25 ranker then reorders so memories matching more tokens / more
 * distinctive tokens rank higher.
 *
 * Empty / all-punctuation queries produce an empty string, which the
 * caller can detect as "no matches" before running the query.
 *
 * Examples:
 *   "cat sleeping on the couch" → `"cat" OR "sleeping" OR "on" OR "the" OR "couch"`
 *   "plain AND NEAR x"          → `"plain" OR "AND" OR "NEAR" OR "x"`
 *                                  (AND/NEAR are quoted → treated as literal words)
 *   "pixel-the-cat"             → `"pixel" OR "the" OR "cat"`
 */
function escapeFtsQuery(query: string): string {
  // Split on any non-alphanumeric run so punctuation and operator chars
  // become token separators. Result is a list of clean tokens.
  const tokens = query
    .split(/[^A-Za-z0-9]+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

/**
 * Resolve the memory database path in priority order:
 *
 *   1. `config.database_path` (from agent.yaml)
 *        - `~/...`            → expanded relative to $HOME
 *        - absolute paths     → used as-is
 *        - relative paths     → resolved against `agentDir` if provided,
 *                                otherwise against cwd
 *   2. `$SPINDLE_MEMORY_DB` env var (same expansion rules)
 *   3. `$XDG_DATA_HOME/spindle/memory.db` (only if XDG_DATA_HOME is absolute)
 *   4. `$HOME/.local/share/spindle/memory.db`
 *   5. Throws with a clear error if none of the above resolve
 */
export function resolveMemoryDbPath(
  config: { database_path?: string },
  env: NodeJS.ProcessEnv,
  agentDir?: string
): string {
  if (config.database_path) {
    return expandPath(config.database_path, env, agentDir);
  }
  const override = env.SPINDLE_MEMORY_DB;
  if (override) {
    return expandPath(override, env, agentDir);
  }
  const xdg = env.XDG_DATA_HOME;
  if (xdg && xdg.startsWith("/")) {
    return resolvePath(xdg, "spindle", "memory.db");
  }
  const home = env.HOME ?? homedir();
  if (home) {
    return resolvePath(home, ".local", "share", "spindle", "memory.db");
  }
  throw new Error(
    "cannot resolve memory database path — set memory.database_path in agent.yaml or SPINDLE_MEMORY_DB env var"
  );
}

function expandPath(path: string, env: NodeJS.ProcessEnv, agentDir?: string): string {
  if (path.startsWith("~/")) {
    const home = env.HOME ?? homedir();
    if (!home) throw new Error(`cannot expand ~ in path: HOME not set (${path})`);
    return resolvePath(home, path.slice(2));
  }
  if (path.startsWith("/")) {
    return resolvePath(path);
  }
  // Relative path: resolve against the agent dir (if supplied) for
  // consistency with pi.session_dir, else against cwd.
  return agentDir ? resolvePath(agentDir, path) : resolvePath(path);
}

function ensureParentDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ============================================================================
// Phase 4.1 row shapes + converters
// ============================================================================

interface RawSessionRow {
  id: string;
  agent_id: string;
  file_path: string;
  started_at: number | null;
  last_activity_at: number | null;
  event_count: number;
  last_ingested_byte_offset: number;
  last_ingest_error: string | null;
  last_ingest_error_at: number | null;
  created_at: number;
  updated_at: number;
}

interface RawEventRow {
  id: number;
  agent_id: string;
  session_id: string;
  seq: number;
  byte_offset: number;
  ts: number | null;
  event_type: string;
  pi_event_id: string | null;
  parent_id: string | null;
  role: string | null;
  model: string | null;
  content_json: string;
  content_text: string | null;
}

function rowToSessionRow(r: RawSessionRow): SessionRow {
  return {
    id: r.id,
    agentId: r.agent_id,
    filePath: r.file_path,
    startedAt: r.started_at,
    lastActivityAt: r.last_activity_at,
    eventCount: r.event_count,
    lastIngestedByteOffset: r.last_ingested_byte_offset,
    lastIngestError: r.last_ingest_error,
    lastIngestErrorAt: r.last_ingest_error_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToEventRow(r: RawEventRow): EventRow {
  return {
    id: r.id,
    agentId: r.agent_id,
    sessionId: r.session_id,
    seq: r.seq,
    byteOffset: r.byte_offset,
    ts: r.ts,
    eventType: r.event_type,
    piEventId: r.pi_event_id,
    parentId: r.parent_id,
    role: r.role,
    model: r.model,
    contentJson: r.content_json,
    contentText: r.content_text,
  };
}

/**
 * Clamp caller-supplied pagination options into sensible ranges so a
 * malicious or buggy client can't accidentally materialize the entire
 * table into memory.
 */
function clampListOptions(options: {
  limit?: number;
  offset?: number;
}): { limit: number; offset: number } {
  const DEFAULT_LIMIT = 50;
  const MAX_LIMIT = 500;
  const rawLimit = options.limit ?? DEFAULT_LIMIT;
  const limit = Math.min(Math.max(1, Math.floor(rawLimit)), MAX_LIMIT);
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  return { limit, offset };
}
