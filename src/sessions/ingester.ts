import { open, stat, type FileHandle } from "fs/promises";
import type { MemoryEngine } from "../memory/engine";
import { parseEventLine } from "./parser";
import { discoverSessionFiles } from "./discovery";

export interface IngesterConfig {
  agentId: string;
  sessionDir: string;
  engine: MemoryEngine;
  /** Poll interval in ms. Default 2000. */
  pollIntervalMs?: number;
  /** Max events to insert in a single transaction. Default 500. */
  batchSize?: number;
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

/**
 * Projects pi's JSONL session files into the SQLite sessions + events
 * tables. JSONL is the source of truth; the DB is a queryable
 * projection. Every file has a `last_ingested_byte_offset` watermark
 * so a restart resumes cleanly.
 *
 * Per cycle: discover files, for each file read bytes from watermark
 * to EOF as one chunk, split on newlines, insert rows + advance
 * watermark inside a single SQLite transaction per batch. Malformed
 * lines are logged + skipped; the watermark still advances past them
 * so the same corrupt line is not re-processed forever.
 *
 * A line without a trailing newline is treated as a partial pi write;
 * the watermark stops before it, and the next poll tick picks up the
 * line once it's flushed.
 */
export class SessionIngester {
  private readonly agentId: string;
  private readonly sessionDir: string;
  private readonly engine: MemoryEngine;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly logger: NonNullable<IngesterConfig["logger"]>;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;

  constructor(config: IngesterConfig) {
    this.agentId = config.agentId;
    this.sessionDir = config.sessionDir;
    this.engine = config.engine;
    this.pollIntervalMs = config.pollIntervalMs ?? 2000;
    this.batchSize = config.batchSize ?? 500;
    this.logger = config.logger ?? {
      info: (m) => console.log(m),
      warn: (m) => console.warn(m),
      error: (m) => console.error(m),
    };
  }

  /**
   * Run one full ingest pass over every discovered session file.
   * Returns the total number of newly-inserted event rows. Idempotent
   * — files at their watermark are no-ops.
   */
  async runCycle(): Promise<number> {
    const discovered = await discoverSessionFiles(this.sessionDir);
    let totalNew = 0;
    for (const file of discovered) {
      const existing = this.engine.getSession(this.agentId, file.id);
      if (!existing) {
        this.engine.upsertSession({
          agentId: this.agentId,
          id: file.id,
          filePath: file.path,
        });
      }
      try {
        totalNew += await this.ingestFile(file.id, file.path);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`[ingester] ${file.id}: ${msg}`);
        this.engine.recordSessionIngestError(this.agentId, file.id, msg);
      }
    }
    return totalNew;
  }

  /** Blocking initial backfill. Called from boot. */
  async backfill(): Promise<number> {
    return this.runCycle();
  }

  /**
   * Begin the poll loop. Caller is expected to `await backfill()` first.
   */
  start(): void {
    if (this.stopped) throw new Error("cannot start a stopped ingester");
    if (this.timer) return;
    this.scheduleNext();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        // already logged inside tick
      }
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.inFlight = this.tick().finally(() => {
        this.inFlight = null;
        this.scheduleNext();
      });
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      await this.runCycle();
    } catch (err) {
      this.logger.error(
        `[ingester] cycle error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async ingestFile(sessionId: string, path: string): Promise<number> {
    const current = this.engine.getSession(this.agentId, sessionId);
    if (!current) throw new Error(`session row missing after upsert: ${sessionId}`);

    const fileStat = await stat(path);
    if (fileStat.size <= current.lastIngestedByteOffset) return 0;

    const delta = fileStat.size - current.lastIngestedByteOffset;
    let handle: FileHandle | null = null;
    try {
      handle = await open(path, "r");
      const buf = Buffer.alloc(delta);
      await handle.read(buf, 0, delta, current.lastIngestedByteOffset);

      // Walk the delta line-by-line on BYTE boundaries. Record each
      // line's absolute start offset in the file and its byte length
      // (including trailing newline) so the watermark advances in
      // bytes, not characters — UTF-8 lines with multi-byte chars
      // would otherwise be mis-counted.
      const lines: Array<{ text: string; startByte: number; endByte: number }> = [];
      const baseOffset = current.lastIngestedByteOffset;
      let lineStart = 0;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0a) {
          const slice = buf.subarray(lineStart, i);
          lines.push({
            text: slice.toString("utf8"),
            startByte: baseOffset + lineStart,
            endByte: baseOffset + i + 1,
          });
          lineStart = i + 1;
        }
      }
      // Any trailing bytes without a newline are a partial pi write —
      // leave them for the next poll cycle by not advancing past them.

      let seq = current.eventCount;
      let batch: BatchAccumulator = emptyBatch(current.lastIngestedByteOffset, seq);
      let inserted = 0;

      const flush = () => {
        if (batch.events.length === 0 && batch.newByteOffset === current.lastIngestedByteOffset) {
          return;
        }
        // Even if the batch has zero events (all lines were corrupt),
        // we still want to advance the watermark — so call appendEvents
        // with an empty events array. Our SQL handles that (no-op INSERT
        // loop, UPDATE still runs).
        this.engine.appendEvents({
          agentId: this.agentId,
          sessionId,
          events: batch.events,
          newByteOffset: batch.newByteOffset,
          newEventCount: batch.newEventCount,
          earliestTs: batch.earliestTs,
          latestTs: batch.latestTs,
          clearError: true,
        });
        inserted += batch.events.length;
        batch = emptyBatch(batch.newByteOffset, batch.newEventCount);
      };

      for (const line of lines) {
        const parsed = parseEventLine(line.text, line.startByte);
        if (parsed.error) {
          this.logger.warn(
            `[ingester] ${sessionId}: skip line@${line.startByte}: ${parsed.message}`
          );
          batch.newByteOffset = line.endByte;
        } else {
          const e = parsed.event;
          batch.events.push({
            seq,
            byte_offset: e.byte_offset,
            ts: e.ts,
            event_type: e.event_type,
            pi_event_id: e.pi_event_id,
            parent_id: e.parent_id,
            role: e.role,
            model: e.model,
            content_json: e.content_json,
            content_text: e.content_text,
          });
          seq += 1;
          batch.newEventCount = seq;
          batch.newByteOffset = line.endByte;
          if (e.ts !== null) {
            batch.earliestTs =
              batch.earliestTs === null ? e.ts : Math.min(batch.earliestTs, e.ts);
            batch.latestTs =
              batch.latestTs === null ? e.ts : Math.max(batch.latestTs, e.ts);
          }
          if (batch.events.length >= this.batchSize) flush();
        }
      }

      flush();
      return inserted;
    } finally {
      if (handle) await handle.close();
    }
  }
}

interface BatchAccumulator {
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
}

function emptyBatch(offset: number, count: number): BatchAccumulator {
  return {
    events: [],
    newByteOffset: offset,
    newEventCount: count,
    earliestTs: null,
    latestTs: null,
  };
}
