import { describe, expect, it } from "vitest";
import { consumePlannedAbort, markPlannedAbort } from "./planned-abort";

describe("planned abort", () => {
  it("absorbs the abort that follows a mark, once", () => {
    markPlannedAbort("mud_wait", 1000);
    expect(consumePlannedAbort("Request aborted", 1500)).toBe("mud_wait");
    expect(consumePlannedAbort("Request aborted", 1600)).toBeNull();
  });
  it("leaves real errors alone and keeps the mark for the abort", () => {
    markPlannedAbort("mud_wait", 1000);
    expect(consumePlannedAbort("429 Too Many Requests", 1100)).toBeNull();
    expect(consumePlannedAbort("Request aborted", 1200)).toBe("mud_wait");
  });
  it("ignores an unmarked abort", () => {
    expect(consumePlannedAbort("Request aborted", 1000)).toBeNull();
  });
  it("drops a stale mark", () => {
    markPlannedAbort("mud_wait", 1000);
    expect(consumePlannedAbort("Request aborted", 1000 + 31_000)).toBeNull();
    expect(consumePlannedAbort("Request aborted", 1000 + 31_001)).toBeNull();
  });
});
