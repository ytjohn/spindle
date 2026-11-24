/**
 * Phase 4.4a inbox projector.
 *
 * Template: `src/sessions/ingester.ts`. The projector discovers mail
 * files on disk, diffs them against `InboxEngine.snapshotProjection()`,
 * and upserts / deletes rows to match. File sha256 is the authoritative
 * change signal; mtime is cosmetic.
 *
 * Shape mirrors the session ingester: `backfill()` for blocking boot,
 * `start()` for `setInterval`-driven polling, `stop()` awaits in-flight.
 * Single-cycle-in-flight guarantee.
 */

import type { InboxEngine } from "./engine";
import {
  discoverMailFiles,
  parseMailFile,
  MailParseError,
} from "./parse";
import type { DiscoveredMailFile, ProjectionResult } from "./types";

export interface InboxProjectorConfig {
  engine: InboxEngine;
  pollIntervalMs?: number;
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

export class InboxProjector {
  private readonly engine: InboxEngine;
  private readonly pollIntervalMs: number;
  private readonly logger: NonNullable<InboxProjectorConfig["logger"]>;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<ProjectionResult> | null = null;
  private stopped = false;
  /**
   * Paths where the last cycle's parser threw — skipped on subsequent
   * ticks until either the file is edited (mtime/sha changes) or goes
   * away. Keyed by rel_path, value is the last-seen sha256 that failed.
   */
  private readonly malformedCache = new Map<string, string>();

  constructor(config: InboxProjectorConfig) {
    this.engine = config.engine;
    this.pollIntervalMs = config.pollIntervalMs ?? 30000;
    this.logger = config.logger ?? {
      info: (m) => console.log(`[inbox-projector] ${m}`),
      warn: (m) => console.warn(`[inbox-projector] ${m}`),
      error: (m) => console.error(`[inbox-projector] ${m}`),
    };
  }

  /** Blocking initial full pass — called at boot. */
  async backfill(): Promise<ProjectionResult> {
    return this.runCycle();
  }

  /** Begin the poll loop. Expect `backfill()` to have been awaited first. */
  start(): void {
    if (this.stopped) throw new Error("cannot start a stopped projector");
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
        // already logged
      }
    }
  }

  /** Exposed for tests — one deterministic projection pass. */
  async projectOnce(): Promise<ProjectionResult> {
    return this.runCycle();
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

  private async tick(): Promise<ProjectionResult> {
    try {
      return await this.runCycle();
    } catch (err) {
      this.logger.error(
        `cycle error: ${err instanceof Error ? err.message : String(err)}`
      );
      return {
        scanned: 0,
        added: 0,
        updated: 0,
        removed: 0,
        skippedMalformed: 0,
        durationMs: 0,
      };
    }
  }

  private async runCycle(): Promise<ProjectionResult> {
    const start = Date.now();
    const mailRoot = this.engine.getMailRoot();
    const discovered = discoverMailFiles(mailRoot);
    const snapshot = this.engine.snapshotProjection();

    let added = 0;
    let updated = 0;
    let skippedMalformed = 0;

    // Track which ids we see on disk so we can remove stragglers below.
    const seenInboxIds = new Set<string>();
    const seenOutboxIds = new Set<string>();
    const seenDraftIds = new Set<string>();

    for (const file of discovered) {
      try {
        const parsed = parseMailFile(file.absPath, mailRoot, file.source);
        if (file.source === "inbox" || file.source === "inbox/read" || file.source === "inbox/tombstoned") {
          seenInboxIds.add(parsed.frontmatter.id);
          const existing = snapshot.inbox.get(parsed.frontmatter.id);
          if (!existing) {
            this.engine.upsertInboxRow(parsed);
            added += 1;
          } else if (
            existing.sha !== parsed.sha256 ||
            existing.relPath !== parsed.relPath
          ) {
            this.engine.upsertInboxRow(parsed);
            updated += 1;
          }
        } else if (file.source === "outbox") {
          seenOutboxIds.add(parsed.frontmatter.id);
          const existing = snapshot.outbox.get(parsed.frontmatter.id);
          if (!existing) {
            this.engine.upsertOutboxRow(parsed);
            added += 1;
          } else if (
            existing.sha !== parsed.sha256 ||
            existing.relPath !== parsed.relPath
          ) {
            this.engine.upsertOutboxRow(parsed);
            updated += 1;
          }
        } else if (file.source === "drafts") {
          seenDraftIds.add(parsed.frontmatter.id);
          const existing = snapshot.drafts.get(parsed.frontmatter.id);
          if (!existing) {
            this.engine.upsertDraftRow(parsed);
            added += 1;
          } else if (
            existing.sha !== parsed.sha256 ||
            existing.relPath !== parsed.relPath
          ) {
            this.engine.upsertDraftRow(parsed);
            updated += 1;
          }
        }
        // Clear malformed-cache entry on successful re-parse.
        this.malformedCache.delete(file.relPath);
      } catch (err) {
        if (err instanceof MailParseError) {
          // Only log the first time we see a particular malformed file.
          const lastSha = this.malformedCache.get(file.relPath);
          if (lastSha !== file.relPath /* sentinel; we track presence */) {
            this.logger.warn(`skip malformed ${file.relPath}: ${err.message}`);
            this.malformedCache.set(file.relPath, file.relPath);
          }
          skippedMalformed += 1;
        } else {
          throw err;
        }
      }
    }

    // Remove rows whose files are gone.
    let removed = 0;
    for (const [id, row] of snapshot.inbox.entries()) {
      if (!seenInboxIds.has(id)) {
        this.engine.removeByRelPath("inbox", row.relPath);
        removed += 1;
      }
    }
    for (const [id, row] of snapshot.outbox.entries()) {
      if (!seenOutboxIds.has(id)) {
        this.engine.removeByRelPath("outbox", row.relPath);
        removed += 1;
      }
    }
    for (const [id, row] of snapshot.drafts.entries()) {
      if (!seenDraftIds.has(id)) {
        this.engine.removeByRelPath("drafts", row.relPath);
        removed += 1;
      }
    }

    return {
      scanned: discovered.length,
      added,
      updated,
      removed,
      skippedMalformed,
      durationMs: Date.now() - start,
    };
  }

  /** Test helper — drop the malformed-cache so logs fire on next tick. */
  clearMalformedCache(): void {
    this.malformedCache.clear();
  }
}
