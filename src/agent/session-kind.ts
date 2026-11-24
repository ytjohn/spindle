/**
 * What kind of pi session is being constructed right now.
 *
 * Helper sessions (daydream, scheduler runs, one-off sessions a channel
 * starts) are built from the main session's extension paths, so every
 * extension's register() runs again inside them. An extension that owns
 * something singular — a channel's inbound handler, a prompt splice —
 * must not claim it a second time for a session that will be thrown away.
 * It reads the kind here at register time and decides for itself.
 *
 * The factory building a helper session sets the kind just before pi
 * loads extensions and puts "main" back in a finally. Construction is
 * serialised, so one process-wide slot is enough.
 *
 * Process-wide via Symbol.for: pi loads extensions through its own
 * module loader, which gives them a separate module graph, so a
 * module-level variable here would not be the one they read.
 */

export type SessionKind = "main" | "daydream" | "scheduler" | "oneoff";

const KEY = Symbol.for("@spindle/session-kind");

function slot(): { kind: SessionKind } {
  const g = globalThis as unknown as { [KEY]?: { kind: SessionKind } };
  if (!g[KEY]) g[KEY] = { kind: "main" };
  return g[KEY];
}

export function bindSessionKind(kind: SessionKind): void {
  slot().kind = kind;
}

export function getSessionKind(): SessionKind {
  return slot().kind;
}

/** True while the main session's extensions are loading. */
export function isMainSession(): boolean {
  return slot().kind === "main";
}
