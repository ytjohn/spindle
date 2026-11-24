import { afterEach, describe, expect, it } from "vitest";
import { bindSessionKind, getSessionKind, isMainSession } from "../../src/agent/session-kind";
afterEach(() => {
  bindSessionKind("main");
});

describe("session kind", () => {
  it("is main unless a factory says otherwise, and is shared process-wide", () => {
    expect(getSessionKind()).toBe("main");
    expect(isMainSession()).toBe(true);
    bindSessionKind("scheduler");
    expect((globalThis as Record<symbol, { kind: string }>)[Symbol.for("@spindle/session-kind")].kind).toBe(
      "scheduler",
    );
    expect(isMainSession()).toBe(false);
  });
});
