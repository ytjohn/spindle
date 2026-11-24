import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { parse as parseYaml } from "yaml";
import { validateConfig } from "./schema";
import type { AgentConfig, ValidationResult } from "../types";

export { validateConfig as validateAgentConfig };

/**
 * Substitute `${VAR}` and `${VAR:-default}` references in a raw YAML
 * string against process.env. Keeps secrets out of committed
 * agent.yaml files.
 *
 *   bot_token: "${TELEGRAM_BOT_TOKEN}"
 *   model: "${CHASSY_MODEL:-qwen3.5-35b}"
 *
 * Unrecognized vars (no env value, no default) are replaced with an
 * empty string and a warning is logged. Escaped `\${...}` is treated
 * as a literal `${...}` (rare but keeps parity with shell conventions).
 */
export function interpolateEnv(
  raw: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  // Handle escaped \${...} — replace with a sentinel, then restore at the end.
  const ESCAPE_SENTINEL = "\u0000SPINDLE_DOLLAR\u0000";
  let text = raw.replace(/\\\$\{/g, ESCAPE_SENTINEL);

  text = text.replace(
    /\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/g,
    (_match, name: string, def?: string) => {
      const value = env[name];
      if (value !== undefined) return value;
      if (def !== undefined) return def;
      console.warn(
        `[spindle] agent.yaml references $${"{"}${name}${"}"} but it is not set in the environment`
      );
      return "";
    }
  );

  return text.replace(new RegExp(ESCAPE_SENTINEL, "g"), "${");
}

export function loadAgentConfig(agentDir: string): ValidationResult<AgentConfig> {
  const configPath = join(agentDir, "agent.yaml");
  if (!existsSync(configPath)) {
    return { success: false, errors: [`agent.yaml not found at ${configPath}`] };
  }
  const raw = readFileSync(configPath, "utf-8");
  const interpolated = interpolateEnv(raw);
  const parsed = parseYaml(interpolated);
  return validateConfig(parsed);
}

export function resolveAgentDir(agentDir: string): {
  agentDir: string;
  piDir: string;
  agentsFile: string;
} {
  const resolved = resolve(agentDir);
  return {
    agentDir: resolved,
    piDir: join(resolved, ".pi"),
    agentsFile: join(resolved, "AGENTS.md"),
  };
}
