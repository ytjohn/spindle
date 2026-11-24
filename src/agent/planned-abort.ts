/**
 * Process-wide marker for an abort the agent asked for on purpose.
 *
 * mud_wait ends its turn with ctx.abort(), and pi reports that turn as
 * errorMessage "Request aborted". Without a marker the host logged
 * "[spindle] LLM error: Request aborted" after every wait and counted it
 * toward consecutive_turn_errors, so a healthy waiting agent looked like a
 * failing one. The extension marks the abort just before calling it; the
 * turn tracker consumes the mark and records a clean turn instead.
 *
 * Aborts that signal a problem (the three-strike rate-limit abort) are not
 * marked and still count as errors.
 *
 * globalThis slot, same rationale as provenance/binding.ts: pi's extension
 * loader can re-import a module within one process.
 */

interface Slot {
  reason: string | null;
  at: number;
}

const KEY = Symbol.for("@spindle/planned-abort");
/** A mark older than this is stale and is not applied to a later abort. */
const MAX_AGE_MS = 30_000;

function slot(): Slot {
  const g = globalThis as unknown as { [KEY]?: Slot };
  if (!g[KEY]) g[KEY] = { reason: null, at: 0 };
  return g[KEY];
}

export function markPlannedAbort(reason: string, now = Date.now()): void {
  const s = slot();
  s.reason = reason;
  s.at = now;
}

/**
 * If `error` is an abort and a fresh mark is pending, clear the mark and
 * return its reason. Otherwise return null and leave a fresh mark alone.
 */
export function consumePlannedAbort(error: string | undefined, now = Date.now()): string | null {
  const s = slot();
  if (!s.reason) return null;
  if (now - s.at > MAX_AGE_MS) {
    s.reason = null;
    return null;
  }
  if (!error || !/abort/i.test(error)) return null;
  const reason = s.reason;
  s.reason = null;
  return reason;
}
