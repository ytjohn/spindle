/**
 * Memory engine type definitions.
 *
 * Schema is defined in schema.ts. These types mirror the row shapes
 * returned by the engine's public API — they are NOT the raw SQLite
 * row shape (which has snake_case, BLOB bytes, etc). The engine handles
 * the conversion between storage rows and these friendly types.
 */

export type Visibility = "private" | "shared" | "thread";

export type MemoryKind = "episodic" | "semantic" | "procedural";

/**
 * A stored memory as returned by engine queries.
 */
export interface Memory {
  id: number;
  agentId: string;
  visibility: Visibility;
  threadId: string | null;
  kind: MemoryKind;
  content: string;
  metadata: Record<string, unknown> | null;
  /** Float32Array of the embedding, or null if none was computed. */
  embedding: Float32Array | null;
  createdAt: number;
  lastRecalledAt: number | null;
  recallCount: number;
  /** Ms since epoch when the row was tombstoned, or null if active. */
  tombstonedAt?: number | null;
  /** Short reason string stored alongside the tombstone. */
  tombstoneReason?: string | null;
}

/**
 * A Hebbian co-activation link between two memories. Reinforced on
 * co-recall, decayed on read via `decayedStrength`. Ids are stored
 * canonically with `srcId < dstId` so `(a,b)` and `(b,a)` collapse.
 */
export interface Link {
  srcId: number;
  dstId: number;
  strength: number;
  createdAt: number;
  lastReinforcedAt: number;
}

/**
 * A link annotated with its decayed effective strength as of some
 * `now`. Returned by `getLinks` so callers don't have to repeat the
 * decay math.
 */
export interface LinkWithScore extends Link {
  /** Effective strength after applying on-read exponential decay. */
  effectiveStrength: number;
}

/**
 * One recall/store touch of a memory. Schema v2 (Phase 2.1) writes one
 * of these on every `store` (synthetic initial access) and one per
 * returned memory on every `recall`. ACT-R scoring sums activation
 * over all rows for a given memory.
 */
export interface MemoryAccess {
  memoryId: number;
  accessedAt: number;
}

/**
 * Registered agent record.
 */
export interface AgentRecord {
  id: string;
  displayName: string | null;
  createdAt: number;
  lastSeenAt: number;
}

/**
 * Options for `MemoryEngine.store`.
 */
export interface StoreOptions {
  content: string;
  /** Defaults to 'private' when called via the LLM tool. Extensions can override. */
  visibility?: Visibility;
  /** Required if visibility === 'thread'. */
  threadId?: string;
  /** Defaults to 'semantic' when called via the LLM tool. Extensions can override. */
  kind?: MemoryKind;
  metadata?: Record<string, unknown>;
}

/**
 * Options for `MemoryEngine.recall`. Either `threadId` (exact match) or
 * `threadPattern` (SQL LIKE) may be supplied — never both.
 */
export interface RecallOptions {
  query: string;
  limit?: number;
  /** Exact thread match. Mutually exclusive with `threadPattern`. */
  threadId?: string;
  /** Prefix / LIKE pattern. E.g. "audit:nagios:%". Mutually exclusive with `threadId`. */
  threadPattern?: string;
}

/**
 * A memory returned from `recall`, annotated with its score.
 */
export interface RecallResult {
  memory: Memory;
  score: number;
}

/**
 * One ingested pi session (Phase 4.1). Projection of a `.jsonl` file.
 */
export interface SessionRow {
  id: string;
  agentId: string;
  filePath: string;
  startedAt: number | null;
  lastActivityAt: number | null;
  eventCount: number;
  lastIngestedByteOffset: number;
  lastIngestError: string | null;
  lastIngestErrorAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * One ingested event row. `content_json` is the raw JSONL line verbatim;
 * other fields are projections and may be NULL when absent on the line.
 */
export interface EventRow {
  id: number;
  agentId: string;
  sessionId: string;
  seq: number;
  byteOffset: number;
  ts: number | null;
  eventType: string;
  piEventId: string | null;
  parentId: string | null;
  role: string | null;
  model: string | null;
  contentJson: string;
  contentText: string | null;
}

/**
 * Envelope returned by every list/search engine method.
 */
export interface ListResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}
