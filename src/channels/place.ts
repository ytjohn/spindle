/**
 * Where an embodied agent is, as a `Place`.
 *
 * The only input is a channel's own liveness: for a MUD channel, the room
 * the server reports for the agent's own puppet in answer to the channel's
 * embodiment ping. Never a shared presence file published by the game — such
 * a file hides characters in private rooms from everyone else by design, and
 * reading it here would blind an agent to its own room exactly there. The
 * operator seeing an agent's own room in a session viewer is intended.
 *
 * No room, no place: an empty or missing room yields undefined, never
 * `{ room: "" }`, so agents with no embodied channel send no `place` at all.
 */
import type { Place } from "../provenance/types";
import type { ChannelLiveness } from "./types";

export function placeOf(l: Pick<ChannelLiveness, "room" | "room_id"> | null | undefined): Place | undefined {
  const room = typeof l?.room === "string" ? l.room.trim() : "";
  if (!room) return undefined;
  const id = l?.room_id;
  return { room, ...(typeof id === "number" && Number.isFinite(id) ? { roomId: id } : {}) };
}
