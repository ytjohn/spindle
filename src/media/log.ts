/**
 * The record of media an agent actually delivered.
 *
 * Every outbound image, audio track or voice note ends in one of the
 * Telegram channel's send methods, whichever route called it (an explicit
 * send tool, the auto-send hook, a rescued fake call). Recording there, after
 * a successful send, covers all of them. A workspace channel reads this log to
 * project `media` entries live, to merge them into history, and to serve the
 * bytes by id. The file path never leaves this module's consumers: the wire
 * only ever sees the opaque id.
 *
 * Append-only JSONL at `<agentDir>/.pi/media-log.jsonl`. Process-wide slot,
 * like the provenance binding, because pi can re-import extension modules.
 */

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, extname } from "node:path";

export type MediaType = "image" | "audio" | "voice";

export interface DeliveredMedia {
  /** Opaque, `md_<12 hex>`. The only handle that crosses the wire. */
  id: string;
  at: string;
  /** Session, run and tool call in effect when it was sent, when known. */
  session: string | null;
  run?: string | null;
  toolCallId?: string;
  type: MediaType;
  mime: string;
  /** Absolute path, already confined to the channel's files dir by the sender. */
  path: string;
  bytes: number;
  caption?: string;
  title?: string;
  durationMs?: number;
  /** The channel it travelled: `telegram`. */
  via: string;
  /**
   * The user sent it to the agent, not the other way round (a Telegram photo).
   * Workspace-channel uploads predate the flag and are told apart by `via`.
   */
  inbound?: true;
  /**
   * Still being generated (streamed speech): the record exists
   * from the first audio so a listener can start, `path` is where the finished
   * file will be, and the bytes are in `media/live.ts` meanwhile. Cleared by
   * `update()` when the file is whole. A record read back from disk is never
   * streaming: whatever was making it died with the process.
   */
  streaming?: true;
}

/** Media the user sent in — never projected as something the agent delivered. */
export function isInbound(m: DeliveredMedia): boolean {
  return m.inbound === true;
}

/** Attribution given explicitly wins; the context provider (a channel's session) fills only what is missing. */
export type MediaInput = Omit<DeliveredMedia, "id" | "at" | "session" | "run" | "toolCallId"> & {
  at?: string;
  id?: string;
  session?: string | null;
  run?: string | null;
  toolCallId?: string;
};

/** A fresh media id, for a caller that must name the file before recording it (uploads). */
export function newMediaId(): string {
  return `md_${randomBytes(6).toString("hex")}`;
}

/** What a session-owning channel knows at send time and the Telegram channel does not. */
export type MediaContext = () => { session: string | null; run?: string | null; toolCallId?: string };

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".webm": "audio/webm",
  ".mp4": "audio/mp4",
};

export function mimeFor(path: string, type: MediaType): string {
  return MIME[extname(path).toLowerCase()] ?? (type === "image" ? "application/octet-stream" : "audio/octet-stream");
}

export class MediaLog {
  private items: DeliveredMedia[] | null = null;
  private readonly listeners = new Set<(m: DeliveredMedia) => void>();
  private context: MediaContext | null = null;

  constructor(private readonly file: string) {}

  /** A session-owning channel installs this so a record carries the session and the tool call that sent it. */
  setContext(fn: MediaContext | null): void {
    this.context = fn;
  }

  record(input: MediaInput): DeliveredMedia {
    const { at, id, session, run, toolCallId, ...rest } = input;
    // An explicit session means the sender knew who it was (outbound.deliver);
    // only then is the context's tool call and run *not* borrowed, since they
    // belong to the context provider's session, not necessarily the sender's.
    const ctx = session !== undefined ? null : (this.context?.() ?? { session: null });
    const m: DeliveredMedia = {
      id: id ?? newMediaId(),
      at: at ?? new Date().toISOString(),
      session: session !== undefined ? session : (ctx?.session ?? null),
      ...(run !== undefined ? { run } : ctx?.run !== undefined ? { run: ctx.run } : {}),
      ...(toolCallId ? { toolCallId } : ctx?.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
      ...rest,
    };
    this.all().push(m);
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, JSON.stringify(m) + "\n");
    } catch (err) {
      // Still projected live; only history loses it.
      console.error("[media] log append failed:", err);
    }
    for (const fn of this.listeners) {
      try {
        fn(m);
      } catch (err) {
        console.error("[media] listener failed:", err);
      }
    }
    return m;
  }

  /**
   * Change a record in place: a streamed note becoming a finished file, or
   * gaining its caption. Appended to the log as a second line under the same
   * id (the last one wins on reload) and announced to listeners like a new
   * record, which is how a subscriber sees the entry change. `streaming: false`
   * clears the flag.
   */
  update(id: string, patch: Partial<Omit<DeliveredMedia, "id" | "streaming">> & { streaming?: boolean }): DeliveredMedia | undefined {
    const items = this.all();
    const at = items.findIndex((m) => m.id === id);
    if (at < 0) return undefined;
    const { streaming, ...rest } = patch;
    const next: DeliveredMedia = { ...items[at]!, ...rest };
    if (streaming === true) next.streaming = true;
    else if (streaming === false) delete next.streaming;
    items[at] = next;
    try {
      appendFileSync(this.file, JSON.stringify(next) + "\n");
    } catch (err) {
      console.error("[media] log append failed:", err);
    }
    for (const fn of this.listeners) {
      try {
        fn(next);
      } catch (err) {
        console.error("[media] listener failed:", err);
      }
    }
    return next;
  }

  subscribe(fn: (m: DeliveredMedia) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get(id: string): DeliveredMedia | undefined {
    return this.all().find((m) => m.id === id);
  }

  forSession(session: string): DeliveredMedia[] {
    return this.all().filter((m) => m.session === session);
  }

  private all(): DeliveredMedia[] {
    if (this.items) return this.items;
    // By id, in first-seen order: an updated record is a later line under the same id, and the last one wins.
    const byId = new Map<string, DeliveredMedia>();
    if (existsSync(this.file)) {
      for (const line of readFileSync(this.file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line) as DeliveredMedia;
          if (typeof m.id !== "string" || typeof m.path !== "string") continue;
          // Read back, nothing is streaming: the process that was making it is gone.
          delete m.streaming;
          byId.set(m.id, m);
        } catch {
          /* a torn last line from a crash; skip it */
        }
      }
    }
    this.items = [...byId.values()];
    return this.items;
  }
}

interface Slot {
  log: MediaLog | null;
}

const KEY = Symbol.for("@spindle/media-log");

function slot(): Slot {
  const g = globalThis as unknown as { [KEY]?: Slot };
  if (!g[KEY]) g[KEY] = { log: null };
  return g[KEY];
}

export function bindMediaLog(log: MediaLog | null): void {
  slot().log = log;
}

export function getMediaLog(): MediaLog | null {
  return slot().log;
}
