/**
 * Provenance helpers for pi extensions.
 *
 * An extension that used to call `pi.sendUserMessage(text, {deliverAs})`
 * calls `sendUserMessageFrom(pi, text, origin, {deliverAs})` instead. The
 * message reaches pi exactly as before (`expandPromptTemplates: false`,
 * `source: "extension"`, the same queueing), but it now carries an
 * Origin, so the run it opens has an owner and the transcript gets its
 * `den.origin` entry.
 *
 * When no tracker is bound — an ephemeral daydream/scheduler session, or
 * a test — this degrades to plain `pi.sendUserMessage`, so an extension
 * shared between main and ephemeral sessions keeps working. That is also
 * why callers who must reach the MAIN session pass `ctx.sessionManager`
 * when they have one: the helper refuses to route an ephemeral session's
 * message into the main session's tracker.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getProvenanceTracker } from "./binding";
import type { Origin } from "./types";

export interface SendFromOptions {
  /** Same meaning as pi.sendUserMessage's deliverAs. */
  deliverAs?: "steer" | "followUp";
  /**
   * The calling extension's `ctx.sessionManager`, when available. Used
   * only to confirm this is the tracked (main) session.
   */
  sessionManager?: unknown;
}

/** Origin for something the agent's own machinery injected. */
export function extensionOrigin(id: string, ref?: string): Origin {
  return {
    channel: "extension",
    actor: { kind: "system", id },
    ...(ref ? { ref } : {}),
    at: new Date().toISOString(),
  };
}

// pi refuses prompt() while a compaction runs. Room text and wake timers
// arrive on their own schedule, so a manual /compact (or the nudge runner)
// can easily overlap one — that rejection once went unhandled from a
// fire-and-forget caller and took an agent down mid-compaction. Wait it out:
// compaction ends in seconds to a few minutes, and dropping the text would
// lose world events the agent should see.
const COMPACTION_IN_PROGRESS = /compaction is in progress/i;
const COMPACTION_RETRY_MS = 2_000;
const COMPACTION_MAX_WAIT_MS = 10 * 60_000;

export async function sendUserMessageFrom(
  pi: Pick<ExtensionAPI, "sendUserMessage">,
  text: string,
  origin: Origin,
  options: SendFromOptions = {}
): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      return await sendOnce(pi, text, origin, options);
    } catch (err) {
      const compacting = COMPACTION_IN_PROGRESS.test(err instanceof Error ? err.message : String(err));
      if (!compacting || Date.now() - start >= COMPACTION_MAX_WAIT_MS) throw err;
      await new Promise((r) => setTimeout(r, COMPACTION_RETRY_MS));
    }
  }
}

async function sendOnce(
  pi: Pick<ExtensionAPI, "sendUserMessage">,
  text: string,
  origin: Origin,
  options: SendFromOptions
): Promise<void> {
  const tracker = getProvenanceTracker();
  const usable =
    tracker &&
    (options.sessionManager === undefined || tracker.ownsSessionManager(options.sessionManager));
  if (!usable) {
    await pi.sendUserMessage(text, options.deliverAs ? { deliverAs: options.deliverAs } : undefined);
    return;
  }
  await tracker.dispatch(text, origin, {
    expandPromptTemplates: false,
    source: "extension",
    ...(options.deliverAs ? { streamingBehavior: options.deliverAs } : {}),
  });
}
