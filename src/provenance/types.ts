/**
 * Turn provenance — who caused a user message, through which door, and
 * which of those messages a given agent run belongs to.
 *
 * `Origin` is the wire and transcript shape; `RunRecord` is spindle's
 * in-memory view of one pi agent run.
 *
 * Two ideas this module keeps apart:
 *
 *   - **Origin lives on the message.** One per user message, attached at
 *     dispatch by whoever called `prompt()`. Persisted in the transcript
 *     as a `den.origin` CustomEntry adjacent to the message it describes.
 *
 *   - **Ownership lives on the run.** pi fires `before_agent_start` only
 *     for the prompt that opens a run when the session is idle; steer and
 *     followUp messages are delivered into an already-open run and never
 *     get that hook. So a run has exactly one opening message, and that
 *     message's origin is the run's `owner`. Everything the run consumed,
 *     opening message included, is `origins` — the evidence for `owner`.
 *
 * Neither is ever derived from the body text. The `[telegram] ` style
 * prefixes stay, because the model reads them, but nothing here does.
 */

/** Who caused a user message, and through which channel. */
export interface Origin {
  /**
   * The door. Open set — these are the ones that exist today. A channel
   * uses its own `name` here so the value matches agent-state.json.
   */
  channel:
    | "telegram"
    | "scheduler"
    | "daydream"
    | "system"
    | "cli"
    | "sdk"
    | "extension"
    | (string & {});
  /** Who walked through it. */
  actor: {
    kind: "human" | "agent" | "schedule" | "system";
    /** A person's or agent's id, a schedule entry name, an extension name. */
    id?: string;
    name?: string;
  };
  /** Channel-specific handle: telegram message id, client id, timer id. */
  ref?: string;
  /** When the channel accepted the input — not when the model saw it. */
  at: string;
  /**
   * Whatever the channel wants carried with the message — what the sender
   * was looking at, say. Spindle stores it and hands it back; only the
   * channel that put it there reads it. Absent means none.
   */
  context?: object;
  /**
   * For embodied channels (a MUD, say): the room the agent was in when the
   * input arrived, from its own channel's embodiment ping — never from a
   * shared presence file, which hides private rooms from other characters
   * by design. Absent when the channel has no room.
   */
  place?: Place;
}

/**
 * Where something happened, for embodied channels. `room` is the room name
 * as the channel reports it; `roomId` the numeric id when the channel has
 * one. Never sent empty: no room, no place.
 */
export interface Place {
  room: string;
  roomId?: number;
}

/**
 * How pi delivered the message. `prompt` opened a run; `steer` and
 * `followUp` were queued into one already running. This is what actually
 * happened, not what the caller asked for: a `followUp` requested while
 * the session was idle opens a run and is recorded as `prompt`.
 */
export type Delivery = "prompt" | "steer" | "followUp";

/** One user message, resolved. */
export interface OriginRecord {
  origin: Origin;
  delivery: Delivery;
  /** pi session entry id of the user message, once persisted. */
  entryId?: string;
  /** Run this message was consumed by, if any run was open. */
  run?: string;
}

/** One pi agent run, from `agent_start` to `agent_end`. */
export interface RunRecord {
  id: string;
  /**
   * Origin of the message that opened the run — what spindle decided the
   * run is for. `null` when the run opened without a user message we
   * dispatched: a continue-after-overflow retry, or a caller that
   * bypassed `dispatch()`.
   */
  owner: Origin | null;
  /** Origins of every user message the run consumed, opening one first. */
  origins: Origin[];
  startedAt: string;
  endedAt?: string;
}

/** Events the tracker emits. Channels render from these. */
export type ProvenanceEvent =
  | { type: "run_start"; run: RunRecord }
  | { type: "origin"; record: OriginRecord; run: RunRecord | null }
  | { type: "run_end"; run: RunRecord };

/** customType of the transcript entry adjacent to each user message. */
export const ORIGIN_ENTRY_TYPE = "den.origin";
/** customType of the transcript entry written when a run opens. */
export const RUN_ENTRY_TYPE = "den.run";
/** customType of the transcript entry written when a run closes. */
export const RUN_END_ENTRY_TYPE = "den.run_end";

export interface OriginEntryData {
  /** pi entry id of the user message this describes. */
  for: string;
  origin: Origin;
  delivery: Delivery;
  run?: string;
}

export interface RunEntryData {
  id: string;
  owner: Origin | null;
  /** Only the opening origin is known when this is written; see run_end. */
  origins: Origin[];
  startedAt: string;
}

export interface RunEndEntryData {
  id: string;
  origins: Origin[];
  startedAt: string;
  endedAt: string;
}
