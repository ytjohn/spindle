/**
 * Deliveries to the user: the outbound router.
 *
 * Two layers, and only one of them comes through here. A session's own
 * timeline (what an agent is doing: its activity in a game, its tool calls)
 * is never routed or pushed. A *delivery* is something addressed to the user:
 * a text, image, track or voice note. Every delivery is recorded, so a channel
 * that reads the log always has it, and is then pushed to the destinations it
 * names. The Telegram tools name `telegram`. A tool may instead name a
 * log-reading channel's destination, or nothing: the delivery then reaches the
 * user through that channel alone, and the channel decides whether to notify
 * them.
 *
 * The sender is attributed to the session that actually sent it (from the
 * tool's or handler's own ExtensionContext), not to whatever session a viewer
 * happens to be showing, so a background run's message lands under its own
 * name (its slash command), and a file it sent is linked to its own tool call.
 *
 * Records: append-only `<agentDir>/.pi/outbound-log.jsonl`. Files are also
 * registered in the media log, which is what serves their bytes by id.
 */

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { getBoundTelegramChannel } from "../channels/telegram/binding";
import { getMediaLog, mimeFor, type MediaType } from "../media/log";

export type DeliveryKind = "text" | MediaType;
/**
 * Where a delivery is pushed. `telegram` sends it there. A destination
 * registered by a log-reading channel sends nothing from here: it tells that
 * channel, which already has every delivery, that this one should notify the
 * user through the channel's own push.
 */
export type Destination = "telegram" | (string & {});

/** How hard a delivery pushed by a log-reading channel should try to interrupt. */
export type Urgency = "quiet" | "normal" | "urgent";

/** Who sent it: the session, a human-readable label for it, and the tool call. */
export interface DeliveryFrom {
  session: string | null;
  label?: string;
  toolCallId?: string;
}

export interface Delivery {
  id: string;
  at: string;
  from: DeliveryFrom;
  kind: DeliveryKind;
  /** The message, for `text`. */
  text?: string;
  /** The media-log id, for a file (it serves the bytes). */
  media?: string;
  mime?: string;
  caption?: string;
  title?: string;
  durationMs?: number;
  /** Where it was pushed. Empty means it waits in the log with no notification. */
  push: Destination[];
  /** Set for a text addressed to a log-reading channel. Absent on a Telegram delivery. */
  urgency?: Urgency;
}

export type DeliverInput =
  | { kind: "text"; text: string; from: DeliveryFrom; push?: Destination[]; urgency?: Urgency }
  | {
      kind: MediaType;
      path: string;
      caption?: string;
      title?: string;
      performer?: string;
      /** Seconds, as Telegram takes it. */
      duration?: number;
      from: DeliveryFrom;
      push?: Destination[];
      /**
       * The media record this file already has (streamed speech: `speak`
       * records the note when its audio starts, so a listener can). The
       * delivery then points at that record instead of making a second one
       * for the same note.
       */
      mediaId?: string;
    };

export class OutboundLog {
  private items: Delivery[] | null = null;
  private readonly listeners = new Set<(d: Delivery) => void>();

  constructor(private readonly file: string) {}

  record(d: Delivery): void {
    this.all().push(d);
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, JSON.stringify(d) + "\n");
    } catch (err) {
      console.error("[outbound] log append failed:", err);
    }
    for (const fn of this.listeners) {
      try {
        fn(d);
      } catch (err) {
        console.error("[outbound] listener failed:", err);
      }
    }
  }

  subscribe(fn: (d: Delivery) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  all(): Delivery[] {
    if (this.items) return this.items;
    const out: Delivery[] = [];
    if (existsSync(this.file)) {
      for (const line of readFileSync(this.file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line) as Delivery;
          if (typeof d.id === "string" && typeof d.kind === "string") out.push(d);
        } catch {
          /* a torn last line from a crash */
        }
      }
    }
    this.items = out;
    return out;
  }
}

/**
 * Deliver something to the user. Pushes first and records after, so only what
 * actually went out is recorded as pushed; a failed push throws to the caller
 * as before and records nothing. A logging fault never fails a delivery.
 */
export async function deliver(input: DeliverInput): Promise<Delivery> {
  const push = input.push ?? ["telegram"];
  let path: string | undefined;
  let bytes = 0;
  if (push.includes("telegram")) {
    const tg = getBoundTelegramChannel();
    if (!tg) throw new Error("Telegram channel not available");
    if (input.kind === "text") {
      await tg.sendText(input.text);
    } else {
      const sent =
        input.kind === "image"
          ? await tg.sendImage(input.path, input.caption)
          : input.kind === "voice"
            ? await tg.sendVoice(input.path, input.caption, { duration: input.duration })
            : await tg.sendAudio(input.path, input.caption, { title: input.title, performer: input.performer, duration: input.duration });
      // A transport that reports nothing (a test double) still delivers; it
      // just leaves no file to register.
      path = sent?.path;
      bytes = sent?.bytes ?? 0;
    }
  }

  const d: Delivery = {
    id: `dl_${randomBytes(6).toString("hex")}`,
    at: new Date().toISOString(),
    from: input.from,
    kind: input.kind,
    push,
    ...(input.kind === "text" && input.urgency ? { urgency: input.urgency } : {}),
  };
  try {
    if (input.kind === "text") {
      d.text = input.text;
    } else if (input.mediaId && getMediaLog()?.get(input.mediaId)) {
      const m = getMediaLog()!.update(input.mediaId, { ...(input.caption ? { caption: input.caption } : {}) })!;
      d.media = m.id;
      d.mime = m.mime;
      if (m.caption) d.caption = m.caption;
      if (m.durationMs) d.durationMs = m.durationMs;
    } else if (path) {
      const m = getMediaLog()?.record({
        type: input.kind,
        mime: mimeFor(path, input.kind),
        path,
        bytes,
        via: push[0] ?? "outbound",
        session: input.from.session,
        ...(input.from.toolCallId ? { toolCallId: input.from.toolCallId } : {}),
        ...(input.caption ? { caption: input.caption } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(typeof input.duration === "number" && input.duration > 0 ? { durationMs: Math.round(input.duration * 1000) } : {}),
      });
      if (m) {
        d.media = m.id;
        d.mime = m.mime;
        if (m.caption) d.caption = m.caption;
        if (m.title) d.title = m.title;
        if (m.durationMs) d.durationMs = m.durationMs;
      }
    }
    getOutboundLog()?.record(d);
  } catch (err) {
    console.error("[outbound] record failed:", err);
  }
  return d;
}

/** Minimal shape of pi's ExtensionContext that attribution needs. */
interface SessionView {
  sessionManager?: {
    getSessionId(): string;
    getSessionName?(): string | undefined;
    getEntries?(): unknown[];
  };
}

/**
 * The sending session, from a tool's or handler's own context. The label is
 * the session's name if it has one, else the slash command its first user
 * message ran (a scheduled run starts with its command), else none.
 */
export function fromContext(ctx: SessionView | undefined, toolCallId?: string): DeliveryFrom {
  const sm = ctx?.sessionManager;
  let session: string | null = null;
  let label: string | undefined;
  try {
    session = sm?.getSessionId() ?? null;
    label = sm?.getSessionName?.() || commandOf(sm?.getEntries?.() ?? []);
  } catch {
    /* attribution is best-effort */
  }
  return { session, ...(label ? { label } : {}), ...(toolCallId ? { toolCallId } : {}) };
}

function commandOf(entries: unknown[]): string | undefined {
  for (const e of entries) {
    const m = (e as { type?: string; message?: { role?: string; content?: unknown } }).message;
    if ((e as { type?: string }).type !== "message" || m?.role !== "user") continue;
    const c = m.content;
    const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : "")).join("") : "";
    const hit = /^\s*(\/[a-z0-9][\w-]*)/i.exec(text);
    return hit ? hit[1] : undefined;
  }
  return undefined;
}

interface Slot {
  log: OutboundLog | null;
  /** Destinations with no transport here: something else reads the log for them. */
  destinations?: Set<string>;
}
const KEY = Symbol.for("@spindle/outbound-log");
function slot(): Slot {
  const g = globalThis as unknown as { [KEY]?: Slot };
  if (!g[KEY]) g[KEY] = { log: null };
  return g[KEY];
}
export function bindOutboundLog(log: OutboundLog | null): void {
  slot().log = log;
}
export function getOutboundLog(): OutboundLog | null {
  return slot().log;
}

/**
 * Destinations a channel serves by reading the outbound log rather than
 * by being sent to from here. A channel registers its name once it is up
 * and removes it when it stops; a tool that would address a delivery to
 * that destination alone asks hasDestination() first, because on an agent
 * without the channel the delivery would reach nobody.
 */
export function registerDestination(name: string): void {
  const s = slot();
  (s.destinations ??= new Set()).add(name);
}
export function unregisterDestination(name: string): void {
  slot().destinations?.delete(name);
}
export function hasDestination(name: string): boolean {
  return slot().destinations?.has(name) === true;
}

/**
 * For agent extensions outside this package: the same
 * deliver() through a process-wide slot, so they need no import path.
 */
const DELIVER_KEY = Symbol.for("@spindle/deliver");
(globalThis as unknown as { [DELIVER_KEY]?: typeof deliver })[DELIVER_KEY] = deliver;
