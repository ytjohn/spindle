import { describe, it, expect } from "vitest";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadAgentConfig, resolveAgentDir } from "../../src/config/loader";
import { buildSessionOptions } from "../../src/agent/session";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const exampleDir = join(__dirname, "../../examples/eliza");

describe("spindle boot sequence", () => {
  it("loads example agent config and builds session options", () => {
    const configResult = loadAgentConfig(exampleDir);
    expect(configResult.success).toBe(true);

    if (!configResult.success) return;

    const config = configResult.data;
    expect(config.agent.id).toBe("eliza");
    expect(config.agent.name).toBe("Eliza");

    const options = buildSessionOptions(config, exampleDir);
    expect(options.cwd).toBe(exampleDir);
  });

  it("resolves agent directory paths", () => {
    const dirs = resolveAgentDir(exampleDir);
    expect(dirs.agentDir).toContain("examples/eliza");
    expect(dirs.piDir).toContain("examples/eliza/.pi");
    expect(dirs.agentsFile).toContain("examples/eliza/AGENTS.md");
  });
});
