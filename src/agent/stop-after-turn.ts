/**
 * End the agent's run cleanly after the current turn — the way a tool says
 * "that was my last action" without aborting anything.
 *
 * WHY NOT ctx.abort(). A channel's wait tool used to end its turn with
 * ctx.abort(), deferred so its own result landed first. By then pi had
 * already started the NEXT LLM request, and the abort cancelled it: every
 * single wait wrote an assistant message with stopReason "aborted" /
 * "Request aborted" to the session JSONL. planned-abort.ts kept that out of
 * the journal's error count, but the session file is the record, and a
 * session viewer rendered every wait as a failed turn.
 *
 * pi-agent-core's Agent has a `shouldStopAfterTurn` hook, checked after a
 * turn's whole tool batch has run and before the next LLM call. Nothing in
 * pi-coding-agent sets it, so the host installs one (installStopAfterTurn)
 * that consumes a request made here. No request is in flight, so nothing is
 * cancelled and nothing is written but the turn that actually happened.
 *
 * Unlike a tool result's `terminate: true`, which only stops when EVERY tool
 * in the batch sets it, this works for a mixed batch — an action tool plus
 * the wait tool in one message is the common case.
 *
 * globalThis slot, same rationale as planned-abort.ts: pi's extension loader
 * can re-import a module within one process.
 */

/**
 * Decides what happens to messages already queued for pi when a requested
 * stop fires. Returns the ones to leave queued; the rest are the handler's.
 */
export type QueuedHandler = (queued: unknown[]) => unknown[];

interface Slot {
  reason: string | null;
  installed: boolean;
  onQueued: QueuedHandler | null;
}

const KEY = Symbol.for("@spindle/stop-after-turn");

function slot(): Slot {
  const g = globalThis as unknown as { [KEY]?: Slot };
  if (!g[KEY]) g[KEY] = { reason: null, installed: false, onQueued: null };
  return g[KEY];
}

/**
 * Ask for the run to end after the current turn. Returns false when no host
 * hook is installed, so the caller can fall back to aborting.
 */
export function requestStopAfterTurn(reason: string): boolean {
  const s = slot();
  if (!s.installed) return false;
  s.reason = reason;
  return true;
}

/** Called at every turn end by the installed hook. Clears the request. */
export function consumeStopAfterTurn(): string | null {
  const s = slot();
  const reason = s.reason;
  s.reason = null;
  return reason;
}

// Structural, so this module does not import pi. `any` for the context:
// pi's ShouldStopAfterTurnContext is passed straight through to a prior hook.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StopHook = (context: any, signal?: AbortSignal) => boolean | Promise<boolean>;
interface StoppableAgent {
  shouldStopAfterTurn?: StopHook;
  steer?: (message: never) => void;
}

/**
 * Register who sorts the follow-up queue when a requested stop fires.
 *
 * WHY. Stopping cleanly is not enough on its own: after any run ends,
 * pi-coding-agent's _handlePostAgentRun calls agent.continue() if anything
 * is queued. Room events that arrived DURING the turn that called the wait
 * tool were queued as followUps, so they opened a new run within
 * milliseconds and ended the wait before it began — 113 of one agent's 126
 * waits in a day ended that way. The handler gets those messages first and
 * holds what does not concern a waiting agent.
 */
export function setQueuedHandler(handler: QueuedHandler | null): void {
  slot().onQueued = handler;
}

/**
 * pi-agent-core keeps the follow-up queue in a TS-private field
 * (`followUpQueue`, a PendingMessageQueue with a `messages` array). Reached
 * structurally and only if it has exactly that shape — on a pi that changes
 * it, sorting is skipped and the queue is left alone (old behaviour).
 *
 * Returns the messages the handler kept, already REMOVED from the follow-up
 * queue, or null when nothing was sorted. Kept messages cannot simply stay
 * queued: after a stop, pi's continue() resumes from the tool result and
 * calls the model BEFORE it delivers queued follow-ups (seen in practice:
 * a run with no input, in which the agent decided nobody had replied and
 * moved on). The caller turns them into steering instead.
 */
function sortQueue(agent: StoppableAgent): unknown[] | null {
  const handler = slot().onQueued;
  if (!handler) return null;
  const q = (agent as unknown as { followUpQueue?: { messages?: unknown } }).followUpQueue;
  if (!q || !Array.isArray(q.messages) || q.messages.length === 0) return null;
  const queued = q.messages.slice();
  let kept: unknown[];
  try {
    kept = handler(queued);
  } catch (e) {
    console.error("[stop-after-turn] queued handler threw; queue left as it was", e);
    return null;
  }
  q.messages = [];
  return kept;
}

/**
 * Wire the slot into an Agent. Chains any hook already present, so a future
 * pi that sets its own is not silently replaced.
 */
export function installStopAfterTurn(agent: StoppableAgent): void {
  const prior = agent.shouldStopAfterTurn;
  agent.shouldStopAfterTurn = async (context, signal) => {
    // Consume FIRST and unconditionally: a request belongs to the turn it
    // was made in, and must not leak into a later one.
    const mine = consumeStopAfterTurn() !== null;
    if (mine) {
      const kept = sortQueue(agent);
      if (kept && kept.length > 0 && typeof agent.steer === "function") {
        // Something queued during this turn needs the agent after all. Do
        // not stop: deliver it as steering, which the loop injects BEFORE
        // the next model call, so the model sees "Waiting…" and then what
        // interrupted it — instead of resuming blind from the tool result.
        for (const m of kept) agent.steer(m as never);
        return false;
      }
      if (kept && kept.length > 0) {
        // No steer() on this pi: put them back and stop as before.
        const q = (agent as unknown as { followUpQueue: { messages: unknown[] } }).followUpQueue;
        q.messages = kept;
      }
      return true;
    }
    return prior ? await prior(context, signal) : false;
  };
  slot().installed = true;
}

/** Test-only. */
export function _resetStopAfterTurn(): void {
  const s = slot();
  s.reason = null;
  s.installed = false;
  s.onQueued = null;
}
