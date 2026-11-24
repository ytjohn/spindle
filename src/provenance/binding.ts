/**
 * Process-wide slot for the main session's ProvenanceTracker.
 *
 * Same rationale as the channel bindings: pi's extension
 * loader can re-import an extension module within one process, so
 * module-level state is not a safe rendezvous. The spindle-provenance
 * extension is loaded inside createAgentSession, before the tracker can
 * exist (it needs the session), so it reads this slot lazily at event
 * time rather than at register time.
 */

import type { ProvenanceTracker } from "./tracker";

interface Slot {
  tracker: ProvenanceTracker | null;
  /** Trackers of the agent's other live sessions (one-off sessions opened by a channel plugin). */
  extra: Set<ProvenanceTracker>;
}

const KEY = Symbol.for("@spindle/provenance-binding");

function slot(): Slot {
  const g = globalThis as unknown as { [KEY]?: Slot };
  if (!g[KEY]) g[KEY] = { tracker: null, extra: new Set() };
  g[KEY].extra ??= new Set();
  return g[KEY];
}

export function bindProvenanceTracker(tracker: ProvenanceTracker | null): void {
  slot().tracker = tracker;
}

export function getProvenanceTracker(): ProvenanceTracker | null {
  return slot().tracker;
}

/**
 * Register the tracker of a session other than the main one, so an extension
 * running inside that session can find it by `trackerFor(ctx.sessionManager)`.
 * Returns the unregister function.
 */
export function registerSessionTracker(tracker: ProvenanceTracker): () => void {
  slot().extra.add(tracker);
  return () => {
    slot().extra.delete(tracker);
  };
}

/**
 * The tracker that owns this session manager: the main one, or a registered
 * session's. Null for a session nobody tracks (a scheduler run).
 */
export function trackerFor(sessionManager: unknown): ProvenanceTracker | null {
  const s = slot();
  if (s.tracker?.ownsSessionManager?.(sessionManager)) return s.tracker;
  for (const t of s.extra) if (t.ownsSessionManager?.(sessionManager)) return t;
  return null;
}
