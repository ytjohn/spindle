/**
 * spindle-provenance — resolves run ownership at `before_agent_start`.
 *
 * Always injected, first in the extension list, so its handler runs
 * before any channel extension's (a channel's tool scoping reads the
 * result via `getProvenanceTracker().currentRun()`).
 *
 * pi fires `before_agent_start` once per run, for the single user message
 * that opens it, with `prompt` set to that message's exact text. That is
 * the whole job: hand the text to the tracker, which matches it to the
 * dispatch that produced it and publishes the run.
 *
 * Ephemeral sessions (daydream, scheduler) load the same extension paths.
 * The tracker belongs to the main session only, so the handler checks
 * that the context's session manager is the one the tracker owns before
 * doing anything. Everything else stays untouched: no system prompt
 * change, no messages, nothing the model can see.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { trackerFor } from "../../provenance/binding";

/**
 * Spindle's own `src/`, wherever this checkout lives — both as the path
 * it was loaded by and with symlinks resolved, since a stack frame may
 * show either. Recognising spindle by a directory name alone is not
 * enough: under any other name (a git worktree, a clone into another
 * directory) every frame of spindle's own code looked like an extension
 * and the first one — this file — was named as the caller.
 */
const SPINDLE_SRC: string[] = (() => {
  const loaded = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const roots = new Set([loaded]);
  try {
    roots.add(realpathSync(loaded));
  } catch {
    /* not on disk under that path; the loaded path is all there is */
  }
  return [...roots].map((r) => r.replace(/\\/g, "/") + "/");
})();

/**
 * Name the extension that called pi.sendUserMessage, from the stack at
 * the `input` hook: pi calls emitInput synchronously inside prompt(), so
 * the caller's frame is still there. First frame outside pi and spindle
 * core wins; `.pi/extensions/<name>/index.ts` → name, `<name>.ts` → name.
 * Undefined when nothing recognisable is on the stack — the origin then
 * falls back to the generic id. A label, never a trust decision.
 */
export function callerExtensionId(stack: string | undefined = new Error().stack): string | undefined {
  for (const line of (stack ?? "").split("\n")) {
    const m = /((?:\/|[A-Za-z]:\\)[^():\s]+?\.(?:ts|js|mjs|cjs)):\d+/.exec(line);
    if (!m) continue;
    const path = m[1].replace(/\\/g, "/");
    if (path.includes("/node_modules/")) continue;
    if (SPINDLE_SRC.some((root) => path.startsWith(root))) continue;
    if (/\/spindle\/src\//.test(path)) continue;
    const parts = path.split("/");
    const base = parts[parts.length - 1].replace(/\.(ts|js|mjs|cjs)$/, "");
    return base === "index" ? parts[parts.length - 2] : base;
  }
  return undefined;
}

export default function register(pi: ExtensionAPI): void {
  // Catch-all for extensions that still call pi.sendUserMessage directly.
  // pi fires `input` for every prompt with its source; a
  // message from an extension with no dispatch record gets a coarse
  // origin here — channel "extension", actor system — so the run it opens
  // has an owner (nudge scope in a game channel) instead of falling back to
  // prefix classification. Callers that use sendUserMessageFrom() are
  // matched by text and left alone; interactive/rpc input is not touched,
  // since a human typed it and guessing a door would be worse than none.
  pi.on("input", async (event, ctx) => {
    // trackerFor: the main session's tracker, or a channel's one-off session's.
    const tracker = trackerFor(ctx.sessionManager);
    if (!tracker) return { action: "continue" };
    if (event.source === "extension" && !tracker.hasPending(event.text)) {
      tracker.expect(event.text, {
        channel: "extension",
        actor: { kind: "system", id: callerExtensionId() ?? "pi.sendUserMessage" },
        at: new Date().toISOString(),
      });
    }
    return { action: "continue" };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const tracker = trackerFor(ctx.sessionManager);
    if (!tracker) return;
    tracker.openRun(event.prompt);
  });
}
