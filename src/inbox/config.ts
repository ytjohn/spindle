import { homedir } from "os";
import { resolve, isAbsolute } from "path";
import type { AgentConfig } from "../types";
import type { AgentRouteInput, ResolvedInboxConfig } from "./types";

/**
 * Resolve the inbox subsystem's runtime config from an agent.yaml
 * block. Returns null when the block is absent or `enabled !== true`
 * so the boot path can skip InboxEngine wiring silently.
 *
 * Path resolution order for `mail_root`:
 *   1. `inbox.mail_root` (agent.yaml) — absolute / `~/`-expanded /
 *      agent-dir-relative
 *   2. `{agent-dir}/.pi/mail` default
 *
 * Path resolution order for `operator_mail_root`:
 *   1. `inbox.operator_mail_root` (agent.yaml)
 *   2. `$SPINDLE_OPERATOR_MAIL_ROOT` env var
 *   3. `$XDG_DATA_HOME/spindle/operator/mail`
 *   4. `$HOME/.local/share/spindle/operator/mail`
 */
export function resolveInboxConfig(
  config: AgentConfig,
  agentDir: string,
  env: NodeJS.ProcessEnv = process.env
): ResolvedInboxConfig | null {
  const block = config.inbox;
  if (!block || block.enabled !== true) return null;

  const mailRoot = expandPath(block.mail_root ?? ".pi/mail", agentDir, env);
  const operatorMailRoot = resolveOperatorMailRoot(block.operator_mail_root, env);
  const pollIntervalMs = Math.max(1, block.poll_interval_seconds ?? 30) * 1000;
  const contacts: AgentRouteInput[] = (block.contacts ?? []).map((c) => ({
    agentId: c.agent_id,
    mailRoot: expandPath(c.mail_root, agentDir, env),
    displayName: c.display_name ?? c.agent_id,
    avatarPath: c.avatar_path ?? null,
    capabilities: c.capabilities,
    createdBy: "config",
  }));

  return {
    agentId: config.agent.id,
    agentDisplayName:
      block.agent_display_name ?? config.agent.name ?? config.agent.id,
    mailRoot,
    operatorMailRoot,
    pollIntervalMs,
    contacts,
  };
}

function resolveOperatorMailRoot(
  override: string | undefined,
  env: NodeJS.ProcessEnv
): string {
  if (override) return expandPathNoBase(override, env);
  const envOverride = env.SPINDLE_OPERATOR_MAIL_ROOT;
  if (envOverride) return expandPathNoBase(envOverride, env);
  const xdg = env.XDG_DATA_HOME;
  if (xdg && xdg.startsWith("/")) {
    return resolve(xdg, "spindle/operator/mail");
  }
  const home = env.HOME ?? homedir();
  if (home) {
    return resolve(home, ".local/share/spindle/operator/mail");
  }
  throw new Error(
    "cannot resolve operator mail root — set inbox.operator_mail_root or SPINDLE_OPERATOR_MAIL_ROOT"
  );
}

function expandPath(
  path: string,
  agentDir: string,
  env: NodeJS.ProcessEnv
): string {
  if (path.startsWith("~/")) {
    const home = env.HOME ?? homedir();
    if (!home) throw new Error(`cannot expand ~ in path: ${path}`);
    return resolve(home, path.slice(2));
  }
  if (isAbsolute(path)) return path;
  return resolve(agentDir, path);
}

function expandPathNoBase(path: string, env: NodeJS.ProcessEnv): string {
  if (path.startsWith("~/")) {
    const home = env.HOME ?? homedir();
    if (!home) throw new Error(`cannot expand ~ in path: ${path}`);
    return resolve(home, path.slice(2));
  }
  return resolve(path);
}
