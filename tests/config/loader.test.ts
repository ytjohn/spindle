import { describe, it, expect, vi } from "vitest";
import { validateAgentConfig, loadAgentConfig, resolveAgentDir, interpolateEnv } from "../../src/config/loader";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = join(__dirname, "fixtures");

describe("agent config validation", () => {
  it("accepts a valid full config", () => {
    const config = {
      agent: { id: "eliza", name: "Eliza" },
      pi: { provider: "local-vllm", model: "qwen3.5-35b", tools: ["read"] },
    };
    const result = validateAgentConfig(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agent.id).toBe("eliza");
    }
  });

  it("accepts minimal config with just agent.id", () => {
    const config = { agent: { id: "test" } };
    const result = validateAgentConfig(config);
    expect(result.success).toBe(true);
  });

  it("rejects config missing agent.id", () => {
    const config = { agent: {} };
    const result = validateAgentConfig(config);
    expect(result.success).toBe(false);
  });

  it("rejects empty config", () => {
    const config = {};
    const result = validateAgentConfig(config);
    expect(result.success).toBe(false);
  });

  it("accepts telegram allowed_users as plain string array", () => {
    const config = {
      agent: { id: "eliza" },
      channels: {
        telegram: {
          bot_token: "123:abc",
          allowed_users: ["12345678", "87654321"],
        },
      },
    };
    const result = validateAgentConfig(config);
    expect(result.success).toBe(true);
  });

  it("accepts telegram allowed_users as extended object form", () => {
    const config = {
      agent: { id: "eliza" },
      channels: {
        telegram: {
          bot_token: "123:abc",
          allowed_users: [
            { id: "12345678", access: "full" },
            { id: "87654321", session: "guest", access: "single" },
          ],
        },
      },
    };
    const result = validateAgentConfig(config);
    expect(result.success).toBe(true);
  });

  it("accepts telegram allowed_users as mixed form", () => {
    const config = {
      agent: { id: "eliza" },
      channels: {
        telegram: {
          bot_token: "123:abc",
          allowed_users: ["12345678", { id: "87654321", access: "single" }],
        },
      },
    };
    const result = validateAgentConfig(config);
    expect(result.success).toBe(true);
  });

  it("accepts memory config with just enabled: true", () => {
    const config = {
      agent: { id: "eliza" },
      memory: { enabled: true },
    };
    const result = validateAgentConfig(config);
    expect(result.success).toBe(true);
  });

  it("accepts memory config with database_path override", () => {
    const config = {
      agent: { id: "eliza" },
      memory: {
        enabled: true,
        database_path: "~/custom/memory.db",
      },
    };
    const result = validateAgentConfig(config);
    expect(result.success).toBe(true);
  });

  it("accepts memory config with full embedding provider block", () => {
    const config = {
      agent: { id: "eliza" },
      memory: {
        enabled: true,
        embedding: {
          provider: "openai",
          model: "text-embedding-3-small",
          base_url: "http://localhost:8001/v1",
          api_key_env: "OPENAI_API_KEY",
          dimensions: 1536,
        },
      },
    };
    const result = validateAgentConfig(config);
    expect(result.success).toBe(true);
  });

  it("accepts memory.embedding with only provider + model (local vLLM case)", () => {
    const config = {
      agent: { id: "eliza" },
      memory: {
        enabled: true,
        embedding: {
          provider: "vllm",
          model: "nomic-embed-text-v1.5",
        },
      },
    };
    const result = validateAgentConfig(config);
    expect(result.success).toBe(true);
  });

  it("rejects memory.embedding missing required provider", () => {
    const config = {
      agent: { id: "eliza" },
      memory: {
        enabled: true,
        embedding: {
          model: "text-embedding-3-small",
        },
      },
    };
    const result = validateAgentConfig(config);
    expect(result.success).toBe(false);
  });

  it("rejects memory.embedding missing required model", () => {
    const config = {
      agent: { id: "eliza" },
      memory: {
        enabled: true,
        embedding: {
          provider: "openai",
        },
      },
    };
    const result = validateAgentConfig(config);
    expect(result.success).toBe(false);
  });

  it("accepts memory.daydream minimal config", () => {
    const config = {
      agent: { id: "eliza" },
      memory: { enabled: true, daydream: { enabled: true } },
    };
    const result = validateAgentConfig(config);
    expect(result.success).toBe(true);
  });

  it("accepts memory.daydream full config with model override", () => {
    const config = {
      agent: { id: "eliza" },
      memory: {
        enabled: true,
        daydream: {
          enabled: true,
          interval_minutes: 15,
          lookback_minutes: 30,
          min_turns_since_last: 3,
          max_store_per_cycle: 10,
          model: {
            provider: "local-vllm",
            model: "qwen3-8b-instruct",
            thinking_level: "off",
          },
        },
      },
    };
    const result = validateAgentConfig(config);
    expect(result.success).toBe(true);
  });

  it("rejects memory.daydream.interval_minutes <= 0", () => {
    const config = {
      agent: { id: "eliza" },
      memory: { enabled: true, daydream: { enabled: true, interval_minutes: 0 } },
    };
    const result = validateAgentConfig(config);
    expect(result.success).toBe(false);
  });

  it("rejects memory.daydream.model missing required fields", () => {
    const config = {
      agent: { id: "eliza" },
      memory: {
        enabled: true,
        daydream: {
          enabled: true,
          model: { provider: "local-vllm" }, // missing `model`
        },
      },
    };
    const result = validateAgentConfig(config);
    expect(result.success).toBe(false);
  });

  it("rejects memory.daydream.min_turns_since_last as non-integer", () => {
    const config = {
      agent: { id: "eliza" },
      memory: {
        enabled: true,
        daydream: { enabled: true, min_turns_since_last: 2.5 },
      },
    };
    const result = validateAgentConfig(config);
    expect(result.success).toBe(false);
  });

  it("rejects memory.embedding dimensions <= 0", () => {
    const config = {
      agent: { id: "eliza" },
      memory: {
        enabled: true,
        embedding: {
          provider: "openai",
          model: "x",
          dimensions: 0,
        },
      },
    };
    const result = validateAgentConfig(config);
    expect(result.success).toBe(false);
  });

  it("accepts memory.scoring with linear mode", () => {
    const config = {
      agent: { id: "eliza" },
      memory: { enabled: true, scoring: { mode: "linear" } },
    };
    const result = validateAgentConfig(config);
    expect(result.success).toBe(true);
  });

  it("accepts memory.scoring with act-r mode and weight overrides", () => {
    const config = {
      agent: { id: "eliza" },
      memory: {
        enabled: true,
        scoring: {
          mode: "act-r",
          weights: {
            fts: 1.2,
            link_boost: 0.4,
            act_r_d: 0.6,
            act_r_scale_ms: 60000,
          },
        },
      },
    };
    const result = validateAgentConfig(config);
    expect(result.success).toBe(true);
  });

  it("rejects memory.scoring.mode with an unknown value", () => {
    const config = {
      agent: { id: "eliza" },
      memory: { enabled: true, scoring: { mode: "wishful" } },
    };
    const result = validateAgentConfig(config);
    expect(result.success).toBe(false);
  });

  it("rejects memory.scoring.weights.decay_ms <= 0", () => {
    const config = {
      agent: { id: "eliza" },
      memory: { enabled: true, scoring: { weights: { decay_ms: 0 } } },
    };
    const result = validateAgentConfig(config);
    expect(result.success).toBe(false);
  });

  it("accepts memory.association with full overrides", () => {
    const config = {
      agent: { id: "eliza" },
      memory: {
        enabled: true,
        association: { enabled: true, seed_count: 8, per_seed: 4 },
      },
    };
    const result = validateAgentConfig(config);
    expect(result.success).toBe(true);
  });

  it("accepts memory.association.enabled: false (opt-out)", () => {
    const config = {
      agent: { id: "eliza" },
      memory: { enabled: true, association: { enabled: false } },
    };
    const result = validateAgentConfig(config);
    expect(result.success).toBe(true);
  });

  it("rejects memory.association.seed_count below 1", () => {
    const config = {
      agent: { id: "eliza" },
      memory: { enabled: true, association: { seed_count: 0 } },
    };
    const result = validateAgentConfig(config);
    expect(result.success).toBe(false);
  });

  it("rejects memory.association.per_seed as non-integer", () => {
    const config = {
      agent: { id: "eliza" },
      memory: { enabled: true, association: { per_seed: 2.5 } },
    };
    const result = validateAgentConfig(config);
    expect(result.success).toBe(false);
  });

  it("rejects telegram allowed_users with invalid access value", () => {
    const config = {
      agent: { id: "eliza" },
      channels: {
        telegram: {
          bot_token: "123:abc",
          allowed_users: [{ id: "12345678", access: "admin" }],
        },
      },
    };
    const result = validateAgentConfig(config);
    expect(result.success).toBe(false);
  });

  it("accepts a web block with enabled + port + bind_host + token_env", () => {
    const config = {
      agent: { id: "eliza" },
      web: {
        enabled: true,
        port: 8787,
        bind_host: "127.0.0.1",
        token_env: "SPINDLE_WEB_TOKEN",
      },
    };
    const result = validateAgentConfig(config);
    expect(result.success).toBe(true);
  });

  it("accepts minimal web block with just enabled + port", () => {
    const config = {
      agent: { id: "eliza" },
      web: { enabled: true, port: 8787 },
    };
    const result = validateAgentConfig(config);
    expect(result.success).toBe(true);
  });

  it("rejects web.port out of range", () => {
    const config = {
      agent: { id: "eliza" },
      web: { enabled: true, port: 70000 },
    };
    const result = validateAgentConfig(config);
    expect(result.success).toBe(false);
  });

});

describe("loadAgentConfig from file", () => {
  it("loads a valid agent.yaml", () => {
    const result = loadAgentConfig(fixturesDir);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agent.id).toBe("eliza");
      expect(result.data.pi?.provider).toBe("local-vllm");
    }
  });

  it("fails for nonexistent directory", () => {
    const result = loadAgentConfig("/tmp/does-not-exist-harness-test");
    expect(result.success).toBe(false);
  });
});

describe("resolveAgentDir", () => {
  it("resolves .pi and AGENTS.md paths", () => {
    const dirs = resolveAgentDir("/home/user/agents/eliza");
    expect(dirs.piDir).toBe("/home/user/agents/eliza/.pi");
    expect(dirs.agentsFile).toBe("/home/user/agents/eliza/AGENTS.md");
  });
});

describe("interpolateEnv", () => {
  it("substitutes a bare ${VAR} reference", () => {
    expect(interpolateEnv('token: "${FOO}"', { FOO: "abc123" })).toBe(
      'token: "abc123"'
    );
  });

  it("uses the default when ${VAR:-default} is set and var is unset", () => {
    expect(interpolateEnv("model: ${M:-qwen3.5-35b}", {})).toBe(
      "model: qwen3.5-35b"
    );
  });

  it("prefers the env value when both var and default are present", () => {
    expect(interpolateEnv("m: ${M:-fallback}", { M: "real" })).toBe(
      "m: real"
    );
  });

  it("warns and blanks out unknown ${VAR} without a default", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(interpolateEnv("token: ${MISSING}", {})).toBe("token: ");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("MISSING"));
    warn.mockRestore();
  });

  it("leaves literal text alone when no $ expressions are present", () => {
    const text = "agent:\n  id: eliza\n  name: Eliza\n";
    expect(interpolateEnv(text, {})).toBe(text);
  });

  it("treats \\${...} as a literal ${...}", () => {
    expect(interpolateEnv("literal: \\${NOT_EXPANDED}", { NOT_EXPANDED: "x" }))
      .toBe("literal: ${NOT_EXPANDED}");
  });

  it("handles multiple substitutions on one line", () => {
    const out = interpolateEnv("${A}/${B}", { A: "alpha", B: "beta" });
    expect(out).toBe("alpha/beta");
  });
});
