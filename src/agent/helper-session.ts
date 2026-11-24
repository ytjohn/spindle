/**
 * A helper session a channel starts beside the main one: same agent, same
 * model, same extensions, its own conversation — and saved to disk in pi's
 * default folder for the agent, so it can be read and resumed like any
 * other session. (The scheduler's and daydream's sessions are built the
 * same way but are thrown away; see their factories.)
 *
 * Extensions load again inside it. While they do, the session kind is
 * "oneoff", memory is in its helper context (the store tool is offered)
 * and Telegram is in its scheduler context (outbound tools are offered,
 * the inbound side is not claimed). All three go back to "main" before
 * this returns, whether or not the session was built.
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type AgentSession,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import { helperContextFiles, type SharedSessionDeps } from "./session";
import { bindSessionKind } from "./session-kind";
import { bindLoadContext } from "../memory/binding";
import { bindTelegramLoadContext } from "../channels/telegram/binding";

export interface OneOffSessionOptions {
  /** Prefix for log lines about this session. Default "[spindle]". */
  logPrefix?: string;
}

export async function createOneOffSession(
  deps: SharedSessionDeps,
  options: OneOffSessionOptions = {},
): Promise<AgentSession> {
  const logPrefix = options.logPrefix ?? "[spindle]";
  bindLoadContext("daydream");
  bindTelegramLoadContext("scheduler");
  bindSessionKind("oneoff");
  try {
    const resourceLoader = new DefaultResourceLoader({
      cwd: deps.agentDir,
      agentDir: deps.agentDir,
      settingsManager: deps.settingsManager,
      ...(deps.noSkills ? { noSkills: true } : {}),
      ...(deps.noExtensions ? { noExtensions: true } : {}),
      ...(deps.extensionPaths.length > 0 ? { additionalExtensionPaths: deps.extensionPaths } : {}),
      // The same AGENTS.md / CLAUDE.md choice as the main session.
      ...helperContextFiles(deps),
    });
    await resourceLoader.reload();
    const sessionOptions: Record<string, unknown> = {
      cwd: deps.agentDir,
      modelRuntime: deps.modelRuntime,
      settingsManager: deps.settingsManager,
      // pi's default folder for this agent, where session readers look.
      sessionManager: SessionManager.create(deps.agentDir),
      resourceLoader,
      ...(deps.mainModel ? { model: deps.mainModel } : {}),
    };
    const { session, extensionsResult } = await createAgentSession(sessionOptions as CreateAgentSessionOptions);
    for (const failure of extensionsResult?.errors ?? []) {
      console.error(`${logPrefix} one-off session: extension failed to load: ${failure.path}: ${failure.error}`);
    }
    return session;
  } finally {
    bindLoadContext("main");
    bindTelegramLoadContext("main");
    bindSessionKind("main");
  }
}
