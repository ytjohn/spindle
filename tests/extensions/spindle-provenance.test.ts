import { describe, it, expect, afterEach } from "vitest";
import register, { callerExtensionId } from "../../src/extensions/spindle-provenance/index";
import { bindProvenanceTracker } from "../../src/provenance/binding";

/** Captures pi.on handlers so the test can fire input events directly. */
function fakePi() {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
  return {
    pi: { on: (name: string, h: any) => handlers.set(name, h) } as any,
    fire: (name: string, event: any, ctx: any) => handlers.get(name)!(event, ctx),
  };
}

afterEach(() => bindProvenanceTracker(null));

describe("spindle-provenance input catch-all", () => {
  it("registers a coarse origin for extension-sourced input with no dispatch record", async () => {
    const sm = {};
    const expected: any[] = [];
    bindProvenanceTracker({
      ownsSessionManager: (x: unknown) => x === sm,
      hasPending: (t: string) => t === "already dispatched",
      expect: (text: string, origin: any) => expected.push({ text, origin }),
    } as any);
    const { pi, fire } = fakePi();
    register(pi);
    const ctx = { sessionManager: sm };

    expect(await fire("input", { type: "input", text: "[inner thought] x", source: "extension" }, ctx)).toEqual({ action: "continue" });
    expect(expected).toHaveLength(1);
    // The actor id is the calling file, read off the stack: this test.
    expect(expected[0]).toMatchObject({ text: "[inner thought] x", origin: { channel: "extension", actor: { kind: "system", id: "spindle-provenance.test" } } });

    // Already dispatched through the tracker: left alone.
    await fire("input", { type: "input", text: "already dispatched", source: "extension" }, ctx);
    // A human typed it: not guessed.
    await fire("input", { type: "input", text: "hello", source: "interactive" }, ctx);
    // Another session's manager (daydream): not ours.
    await fire("input", { type: "input", text: "[inner thought] y", source: "extension" }, { sessionManager: {} });
    expect(expected).toHaveLength(1);
  });

  it("names the calling extension from a stack trace", () => {
    const stack = [
      "Error",
      "    at register (/home/u/projects/spindle/src/extensions/spindle-provenance/index.ts:40:5)",
      "    at emitInput (/home/u/projects/spindle/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:750:3)",
      "    at AgentSession.prompt (/home/u/projects/spindle/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:692:7)",
      "    at fire (/home/u/projects/game/agents/guide/.pi/extensions/guide-coach/index.ts:301:8)",
    ].join("\n");
    expect(callerExtensionId(stack)).toBe("guide-coach");
    expect(callerExtensionId(stack.replace("guide-coach/index.ts", "room-awareness.ts"))).toBe("room-awareness");
    expect(callerExtensionId("Error\n    at x (/home/u/projects/spindle/src/index.ts:1:1)")).toBeUndefined();
  });
});
