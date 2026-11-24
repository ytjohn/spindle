import { describe, it, expect } from "vitest";
import { buildSessionOptions } from "../../src/agent/session";
import type { AgentConfig } from "../../src/types";

describe("buildSessionOptions", () => {
  it("creates session options from agent config with pi section", () => {
    const config: AgentConfig = {
      agent: { id: "test-agent", name: "Test" },
      pi: { provider: "local-vllm", model: "cyankiwi/Qwen3.5-35B-A3B-AWQ-4bit" },
    };
    const agentDir = "/tmp/test-agent";
    const options = buildSessionOptions(config, agentDir);
    expect(options.cwd).toBe(agentDir);
    expect(options.model).toBe("local-vllm/cyankiwi/Qwen3.5-35B-A3B-AWQ-4bit");
  });

  it("uses defaults when pi section not specified", () => {
    const config: AgentConfig = {
      agent: { id: "minimal" },
    };
    const options = buildSessionOptions(config, "/tmp/test");
    expect(options.cwd).toBe("/tmp/test");
    expect(options.model).toBeUndefined();
    expect(options.thinkingLevel).toBe("off");
  });

  it("respects thinking_level", () => {
    const config: AgentConfig = {
      agent: { id: "thinker" },
      pi: { thinking_level: "high" },
    };
    const options = buildSessionOptions(config, "/tmp/test");
    expect(options.thinkingLevel).toBe("high");
  });
});
