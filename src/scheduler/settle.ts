/**
 * runUntilSettled — send a scheduled command and wait until the session's LLM
 * work is finished, INCLUDING pi's own automatic retries.
 *
 * Why not just wait for agent_end: pi emits agent_end for the failed attempt
 * BEFORE it decides whether to retry (AgentSession._runAgentPrompt:
 * prompt -> while (_handlePostAgentRun()) continue -> agent_settled). The
 * runner used to resolve on the first agent_end and close the session, which
 * killed every retry pi had just scheduled — for every provider. Three
 * 10-22 minute research runs were lost that way. pi emits
 * agent_settled exactly once, after the last attempt, so that is the event
 * that means "done".
 *
 * Fallback for a pi without agent_settled: after an agent_end, if no retry
 * starts and nothing settles within `graceMs`, treat the run as finished.
 */

export interface SettleSession {
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(text: string): Promise<unknown>;
  readonly isStreaming?: boolean;
}

export interface SettleResult {
  /** An agent_end or agent_settled was seen. */
  turnEnded: boolean;
  /** Error of the FINAL assistant reply; undefined if a retry recovered. */
  turnError?: string;
  assistantText: string;
  /** pi auto_retry_start events seen. */
  retries: number;
  timedOut: boolean;
}

interface PiEvent {
  type?: string;
  message?: { role?: string; errorMessage?: string };
  assistantMessageEvent?: { type?: string; delta?: string };
}

export async function runUntilSettled(
  session: SettleSession,
  command: string,
  timeoutMs: number,
  opts: { graceMs?: number } = {},
): Promise<SettleResult> {
  const graceMs = opts.graceMs ?? 15_000;
  const r: SettleResult = { turnEnded: false, assistantText: "", retries: 0, timedOut: false };

  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => { finish = resolve; });
  let grace: ReturnType<typeof setTimeout> | null = null;
  const clearGrace = () => { if (grace) { clearTimeout(grace); grace = null; } };

  const unsubscribe = session.subscribe((raw) => {
    const e = raw as PiEvent;
    switch (e.type) {
      case "message_update": {
        const a = e.assistantMessageEvent;
        if (a?.type === "text_delta" && typeof a.delta === "string") r.assistantText += a.delta;
        break;
      }
      case "message_end":
        if (e.message?.errorMessage) r.turnError = e.message.errorMessage;
        // A later successful reply means pi's retry recovered the run.
        else if (e.message?.role === "assistant") r.turnError = undefined;
        break;
      case "auto_retry_start":
        r.retries += 1;
        clearGrace();
        break;
      case "agent_end":
        r.turnEnded = true;
        clearGrace();
        grace = setTimeout(finish, graceMs);
        break;
      case "agent_settled":
        r.turnEnded = true;
        clearGrace();
        finish();
        break;
    }
  });

  try {
    await session.prompt(command);
    // Check streaming after the prompt result is processed: if no LLM turn
    // started (a deterministic slash command), there is nothing to wait for.
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    if (session.isStreaming || r.turnEnded) {
      const timeout = timeoutMs === Infinity ? null
        : setTimeout(() => { r.timedOut = true; finish(); }, timeoutMs);
      await done;
      if (timeout) clearTimeout(timeout);
    }
  } finally {
    clearGrace();
    unsubscribe();
  }
  return r;
}
