import { describe, it, expect } from "vitest";
import { resolveResumeMode } from "../../src/agent/session";
import type { AgentConfig } from "../../src/types";

describe("resolveResumeMode with main_session", () => {
  it("returns 'main' when main_session is true", () => {
    const config = { agent: { id: "test" }, pi: { main_session: true } } as AgentConfig;
    expect(resolveResumeMode(config)).toBe("main");
  });

  it("main_session takes precedence over continue_session", () => {
    const config = {
      agent: { id: "test" },
      pi: { main_session: true, continue_session: true },
    } as AgentConfig;
    expect(resolveResumeMode(config)).toBe("main");
  });

  it("CLI override still wins over main_session", () => {
    const config = { agent: { id: "test" }, pi: { main_session: true } } as AgentConfig;
    expect(resolveResumeMode(config, "new")).toBe("new");
  });
});
