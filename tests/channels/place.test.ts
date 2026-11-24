/**
 * Place: where an embodied agent is, for Origin.place. Built only from a
 * channel's own liveness and never sent empty.
 */
import { describe, it, expect } from "vitest";
import { placeOf } from "../../src/channels/place";
import { origin } from "../../src/provenance/tracker";

describe("placeOf", () => {
  it("maps room / room_id onto { room, roomId }", () => {
    expect(placeOf({ room: "Casey's Room", room_id: 126 })).toEqual({ room: "Casey's Room", roomId: 126 });
  });
  it("omits roomId when the channel has none", () => {
    expect(placeOf({ room: "Workshop", room_id: null })).toEqual({ room: "Workshop" });
    expect(placeOf({ room: "Workshop" })).toEqual({ room: "Workshop" });
  });
  it("no room is no place — never an empty one", () => {
    expect(placeOf({ room: null, room_id: 126 })).toBeUndefined();
    expect(placeOf({ room: "", room_id: 126 })).toBeUndefined();
    expect(placeOf({ room: "   " })).toBeUndefined();
    expect(placeOf({})).toBeUndefined();
    expect(placeOf(undefined)).toBeUndefined();
  });
});

describe("origin() with a place", () => {
  it("carries place only when given one", () => {
    const actor = { kind: "system" as const, id: "room" };
    expect(origin("mud", actor, undefined, undefined, { room: "Workshop", roomId: 7 })).toMatchObject({
      channel: "mud",
      place: { room: "Workshop", roomId: 7 },
    });
    expect("place" in origin("mud", actor)).toBe(false);
    expect("place" in origin("mud", actor, undefined, undefined, undefined)).toBe(false);
  });
});
