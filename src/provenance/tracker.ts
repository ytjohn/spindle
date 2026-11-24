/**
 * ProvenanceTracker — one per live AgentSession.
 *
 * Every caller that puts a user message into the session goes through
 * `dispatch()`, which records the message's Origin *before* calling
 * `session.prompt()`. The tracker then watches pi's event stream and
 * ties each user message back to the origin it was dispatched with.
 *
 * How the correlation works, and why it is not body parsing
 * ----------------------------------------------------------
 * pi 0.70 gives `prompt()` no metadata slot, so the only handle spindle
 * has on a message it sent is the text it sent. Three facts make that a
 * sound key rather than a heuristic:
 *
 *  1. pi itself correlates queued steer/followUp messages to their
 *     `message_start` by exact text equality (`_processAgentEvent`). We
 *     use the same rule over the same strings, so we can never be more
 *     wrong than pi already is about its own queue.
 *  2. `before_agent_start` carries `prompt`, the exact text of the one
 *     user message that opens the run. That is where run ownership is
 *     decided — the same hook a channel's ownership latch was consumed at.
 *  3. `appendMessage` persists the very object `message_end` delivered,
 *     and runs synchronously after listeners. A microtask queued from
 *     the listener can read the new leaf entry and confirm
 *     `entry.message === event.message` by identity before writing the
 *     adjacent `den.origin` entry. No text is involved in that step.
 *
 * What the tracker never does: look at a `[telegram] ` prefix. Those are
 * for the model. If a message reaches pi without going through
 * `dispatch()`, it is simply unattributed, and that is visible.
 */

import type { AgentSession, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  ORIGIN_ENTRY_TYPE,
  RUN_END_ENTRY_TYPE,
  RUN_ENTRY_TYPE,
  type Delivery,
  type Origin,
  type OriginEntryData,
  type OriginRecord,
  type ProvenanceEvent,
  type RunEndEntryData,
  type RunEntryData,
  type RunRecord,
} from "./types";

/** The slice of AgentSession the tracker needs. Narrow so tests can fake it. */
export type TrackerSession = Pick<AgentSession, "subscribe" | "prompt" | "isStreaming"> & {
  sessionManager: Pick<SessionManager, "appendCustomEntry" | "getLeafEntry" | "getEntries">;
};

type PromptOpts = NonNullable<Parameters<AgentSession["prompt"]>[1]>;

export interface DispatchOptions {
  /** Passed through to pi. Required if the session may be streaming. */
  streamingBehavior?: "steer" | "followUp";
  /** Passed through to pi. Default true (slash commands and templates expand). */
  expandPromptTemplates?: boolean;
  images?: PromptOpts["images"];
  /**
   * Passed through to pi's `input` extension event. `pi.sendUserMessage`
   * sends "extension"; an extension migrating from it must keep that or
   * `input` handlers that key on the source change behaviour.
   */
  source?: PromptOpts["source"];
}

interface Pending {
  text: string;
  origin: Origin;
  requested: "steer" | "followUp" | undefined;
  /** Date.now() at dispatch; used only to expire orphans. */
  at: number;
}

interface OpenRun extends RunRecord {
  /** Set on agent_start. A run opened at before_agent_start that never
   *  starts (prompt() threw before the loop) is discarded, not closed. */
  started: boolean;
}

/** Pending dispatches older than this are dropped as orphans. */
const PENDING_TTL_MS = 15 * 60 * 1000;
/** How far back to scan for the persisted entry if the leaf is not it. */
const ENTRY_SCAN_DEPTH = 12;

type UserLikeMessage = { role?: string; content?: unknown };

function userText(message: UserLikeMessage): string {
  // Mirrors pi's _getUserMessageText exactly.
  if (message.role !== "user") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => c?.type === "text")
    .map((c) => c.text)
    .join("");
}

export class ProvenanceTracker {
  private readonly pending: Pending[] = [];
  private opening: { text: string; record: OriginRecord } | null = null;
  private current: OpenRun | null = null;
  /** Owner and origins of the run that last ended, for a retry to inherit. */
  private lastClosed: Pick<RunRecord, "owner" | "origins"> | null = null;
  /** Set between pi's auto_retry_start and the retry's agent_start. */
  private retryOf: Pick<RunRecord, "owner" | "origins"> | null = null;
  private readonly byMessage = new WeakMap<object, OriginRecord>();
  private readonly listeners = new Set<(ev: ProvenanceEvent) => void>();
  private readonly unsubscribe: () => void;
  private runCounter = 0;
  private readonly label: string;

  constructor(
    private readonly session: TrackerSession,
    options: { label?: string } = {}
  ) {
    this.label = options.label ?? "provenance";
    this.unsubscribe = session.subscribe((event) => this.onSessionEvent(event));
  }

  // ── Dispatch ────────────────────────────────────────────────────────

  /**
   * Put a user message into the session with a known origin. Callers use
   * this instead of `session.prompt()`. Throws whatever `prompt()` throws
   * (including pi's "Agent is already processing" when no
   * streamingBehavior is given while streaming) — the origin record is
   * withdrawn in that case so it cannot attach to a later message.
   */
  async dispatch(text: string, origin: Origin, options: DispatchOptions = {}): Promise<void> {
    this.expirePending();
    const entry: Pending = {
      text,
      origin,
      requested: options.streamingBehavior,
      at: Date.now(),
    };
    this.pending.push(entry);
    try {
      await this.session.prompt(text, {
        ...(options.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}),
        ...(options.expandPromptTemplates !== undefined
          ? { expandPromptTemplates: options.expandPromptTemplates }
          : {}),
        ...(options.images ? { images: options.images } : {}),
        ...(options.source ? { source: options.source } : {}),
      });
    } catch (err) {
      this.remove(entry);
      throw err;
    }
    // prompt() awaits the whole run when it opens one, so by now an
    // opening message has been matched and removed. If it returned with
    // the entry still pending and the session idle, pi consumed the text
    // without producing a user message — an extension slash command, or
    // an `input` handler that answered "handled". Withdraw it. Still
    // pending while streaming means it was queued; leave it for the
    // message_start that will deliver it.
    if (!this.session.isStreaming && this.pending.includes(entry)) {
      this.remove(entry);
    }
  }

  /**
   * A dispatch that was queued and then taken back before pi delivered it
   * (a channel plugin holding events back when a wait tool stops a run). Drops
   * the oldest pending entry with exactly this text, so it is not left to
   * expire as an "orphaned dispatch".
   */
  forgetQueued(text: string): void {
    const idx = this.pending.findIndex((p) => p.text === text);
    if (idx !== -1) this.pending.splice(idx, 1);
  }

  /** Is there an undelivered dispatch with exactly this text? */
  hasPending(text: string): boolean {
    return this.pending.some((p) => p.text === text);
  }

  /**
   * Register an origin for a message someone else is about to hand to pi
   * — used by the spindle-provenance `input` hook to attribute messages
   * from extensions that still call `pi.sendUserMessage` directly, so
   * they get a (coarse) owner instead of none. Same matching rules as
   * dispatch(); nothing is sent.
   */
  expect(text: string, origin: Origin, requested?: "steer" | "followUp"): void {
    this.expirePending();
    this.pending.push({ text, origin, requested, at: Date.now() });
  }

  // ── Run ownership (called from the spindle-provenance extension) ────

  /**
   * Called at `before_agent_start` with the exact prompt text pi is about
   * to open a run with. Resolves the run's owner from the pending list
   * and publishes the run so later `before_agent_start` handlers
   * (a channel's tool scoping) can read it via `currentRun()`.
   */
  openRun(promptText: string): RunRecord {
    if (this.current) {
      if (this.current.started) {
        // Should be unreachable: pi refuses prompt() while streaming.
        // Close it rather than leak a run that never ends.
        console.warn(`[${this.label}] run ${this.current.id} still open at before_agent_start — closing`);
        this.closeRun();
      } else {
        // Opened but prompt() failed before the loop began. Discard.
        this.current = null;
      }
    }
    // A new prompt is new work; it inherits nothing from a failed run.
    this.retryOf = null;
    const pending = this.takePending(promptText);
    const record: OriginRecord | null = pending
      ? { origin: pending.origin, delivery: "prompt" }
      : null;
    this.opening = record ? { text: promptText, record } : null;

    const run: OpenRun = {
      id: this.nextRunId(),
      owner: record?.origin ?? null,
      origins: record ? [record.origin] : [],
      startedAt: new Date().toISOString(),
      started: false,
    };
    if (record) record.run = run.id;
    this.current = run;
    if (!record) {
      console.warn(`[${this.label}] run ${run.id} opened by a message dispatched outside the tracker — owner unknown`);
    }
    this.append<RunEntryData>(RUN_ENTRY_TYPE, {
      id: run.id,
      owner: run.owner,
      origins: [...run.origins],
      startedAt: run.startedAt,
    });
    this.emit({ type: "run_start", run: this.snapshot(run) });
    return this.snapshot(run);
  }

  /** True when `sm` is the session manager of the session this tracks. */
  ownsSessionManager(sm: unknown): boolean {
    return sm === this.session.sessionManager;
  }

  // ── Queries ─────────────────────────────────────────────────────────

  /** The run in flight (or about to be), or null when idle. */
  currentRun(): RunRecord | null {
    return this.current ? this.snapshot(this.current) : null;
  }

  /** Convenience for channels: is the current run owned by `channel`? */
  isOwnedBy(channel: string): boolean {
    return this.current?.owner?.channel === channel;
  }

  /** Origin of a user message object seen on the event stream, if known. */
  recordFor(message: object): OriginRecord | undefined {
    return this.byMessage.get(message);
  }

  subscribe(listener: (ev: ProvenanceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stop(): void {
    this.unsubscribe();
    this.listeners.clear();
  }

  // ── Session event handling ──────────────────────────────────────────

  private onSessionEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case "agent_start": {
        if (!this.current) {
          // No before_agent_start preceded this: a continue-after-retry
          // loop, or the extension is not loaded. When it is pi retrying
          // a run whose model call failed, the retry is the same work for
          // the same person and keeps that run's owner. Without that, a
          // reply meant for the channel that asked went wherever an
          // ownerless run's output goes, and anything keyed on the owner
          // (answer in place, live audio) stopped applying on the retry.
          // Otherwise open an ownerless run so the lifecycle stays
          // balanced.
          const retried = this.retryOf;
          this.retryOf = null;
          const run: OpenRun = {
            id: this.nextRunId(),
            owner: retried?.owner ?? null,
            origins: retried ? [...retried.origins] : [],
            startedAt: new Date().toISOString(),
            started: true,
          };
          this.current = run;
          this.append<RunEntryData>(RUN_ENTRY_TYPE, {
            id: run.id,
            owner: run.owner,
            origins: [...run.origins],
            startedAt: run.startedAt,
          });
          this.emit({ type: "run_start", run: this.snapshot(run) });
        } else {
          this.current.started = true;
        }
        break;
      }
      case "message_start": {
        const message = event.message as UserLikeMessage;
        if (message.role !== "user") break;
        this.attachOrigin(message);
        break;
      }
      case "message_end": {
        const message = event.message as UserLikeMessage;
        if (message.role !== "user") break;
        const record = this.byMessage.get(message);
        // pi persists the entry synchronously right after listeners
        // return; a microtask runs after that, before anything else.
        queueMicrotask(() => this.persistOrigin(message, record));
        break;
      }
      case "agent_end": {
        if (this.current) this.closeRun();
        break;
      }
      case "auto_retry_start": {
        // pi is about to run the failed request again. The run it belongs
        // to is the one in flight, or the one that just closed — pi emits
        // this around agent_end, and either order is handled.
        const of = this.current ?? this.lastClosed;
        if (of) this.retryOf = { owner: of.owner, origins: [...of.origins] };
        break;
      }
      case "auto_retry_end": {
        // The retry succeeded (its agent_start already took retryOf) or
        // pi gave up. Either way nothing later may inherit from it.
        this.retryOf = null;
        break;
      }
      default:
        break;
    }
  }

  private attachOrigin(message: UserLikeMessage): void {
    const text = userText(message);
    let record: OriginRecord | undefined;
    if (this.opening && this.opening.text === text) {
      record = this.opening.record;
      this.opening = null;
    } else {
      const pending = this.takePending(text);
      if (pending) {
        // A message arriving mid-run was queued: pi delivered it as
        // whatever the caller asked for. followUp is pi's default when
        // streamingBehavior was given as followUp; steer otherwise.
        const delivery: Delivery = pending.requested ?? "followUp";
        record = { origin: pending.origin, delivery };
      }
    }
    if (!record) {
      console.warn(`[${this.label}] user message with no dispatch record — unattributed (${text.slice(0, 60)}…)`);
      return;
    }
    if (this.current) {
      record.run = this.current.id;
      if (record.delivery !== "prompt") this.current.origins.push(record.origin);
    }
    this.byMessage.set(message, record);
  }

  private persistOrigin(message: UserLikeMessage, record: OriginRecord | undefined): void {
    const entry = this.findEntryFor(message);
    if (!entry) {
      console.warn(`[${this.label}] could not find persisted entry for user message — den.origin not written`);
      return;
    }
    if (!record) {
      // Unattributed message: emit nothing, write nothing. The absence
      // is the honest signal (contract §4.1).
      return;
    }
    record.entryId = entry.id;
    this.append<OriginEntryData>(ORIGIN_ENTRY_TYPE, {
      for: entry.id,
      origin: record.origin,
      delivery: record.delivery,
      ...(record.run ? { run: record.run } : {}),
    });
    this.emit({ type: "origin", record: { ...record }, run: this.currentRun() });
  }

  private findEntryFor(message: object): SessionEntry | undefined {
    return findPersistedEntry(this.session.sessionManager, message);
  }

  private closeRun(): void {
    const run = this.current!;
    run.endedAt = new Date().toISOString();
    this.current = null;
    this.opening = null;
    this.lastClosed = { owner: run.owner, origins: [...run.origins] };
    this.append<RunEndEntryData>(RUN_END_ENTRY_TYPE, {
      id: run.id,
      origins: [...run.origins],
      startedAt: run.startedAt,
      endedAt: run.endedAt,
    });
    this.emit({ type: "run_end", run: this.snapshot(run) });
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private takePending(text: string): Pending | undefined {
    let idx = this.pending.findIndex((p) => p.text === text);
    if (idx === -1) {
      // A slash command that pi expanded from a prompt template: the
      // text changed between dispatch and delivery. The oldest pending
      // command is the only candidate.
      idx = this.pending.findIndex((p) => p.text.startsWith("/"));
    }
    if (idx === -1) return undefined;
    return this.pending.splice(idx, 1)[0];
  }

  private remove(entry: Pending): void {
    const idx = this.pending.indexOf(entry);
    if (idx !== -1) this.pending.splice(idx, 1);
  }

  private expirePending(): void {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i].at < cutoff) {
        console.warn(`[${this.label}] dropping orphaned dispatch from ${this.pending[i].origin.channel}`);
        this.pending.splice(i, 1);
      }
    }
  }

  private nextRunId(): string {
    this.runCounter += 1;
    return `run_${Date.now().toString(36)}_${this.runCounter.toString(36)}`;
  }

  private append<T>(customType: string, data: T): void {
    try {
      this.session.sessionManager.appendCustomEntry(customType, data);
    } catch (err) {
      console.error(`[${this.label}] failed to write ${customType}:`, err);
    }
  }

  private snapshot(run: OpenRun): RunRecord {
    const { started: _started, ...rest } = run;
    return { ...rest, origins: [...rest.origins] };
  }

  private emit(ev: ProvenanceEvent): void {
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch (err) {
        console.error(`[${this.label}] listener threw:`, err);
      }
    }
  }
}

/**
 * Find the session entry pi persisted for a message object seen on the
 * event stream — by object identity, never by text. Valid from the
 * microtask after `message_end` onward (pi appends synchronously after
 * listeners return). Checks the leaf first, then walks back a few
 * entries in case something was appended in between.
 */
export function findPersistedEntry(
  sm: Pick<SessionManager, "getLeafEntry" | "getEntries">,
  message: object
): SessionEntry | undefined {
  const isIt = (e: SessionEntry | undefined) =>
    !!e && e.type === "message" && (e as { message?: unknown }).message === message;
  const leaf = sm.getLeafEntry();
  if (isIt(leaf)) return leaf;
  const entries = sm.getEntries();
  for (let i = entries.length - 1, n = 0; i >= 0 && n < ENTRY_SCAN_DEPTH; i--, n++) {
    if (isIt(entries[i])) return entries[i];
  }
  return undefined;
}

/** Build an Origin with `at` filled in. `place` only for embodied channels. */
export function origin(
  channel: Origin["channel"],
  actor: Origin["actor"],
  ref?: string,
  context?: Origin["context"],
  place?: Origin["place"]
): Origin {
  return {
    channel,
    actor,
    ...(ref ? { ref } : {}),
    ...(place ? { place } : {}),
    at: new Date().toISOString(),
    ...(context ? { context } : {}),
  };
}

/**
 * A tracker for a session other than the main one (a helper session a
 * channel started). For callers that reach this module through the
 * published API and so cannot `new` the class themselves.
 */
export function createProvenanceTracker(
  session: TrackerSession,
  options: { label?: string } = {},
): ProvenanceTracker {
  return new ProvenanceTracker(session, options);
}
