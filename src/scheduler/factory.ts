/**
 * Scheduler session factory — creates ephemeral pi sessions for cron-fired
 * command invocations. Distinct from the daydream factory in two ways:
 *
 *  1. No system-prompt injection — the scheduler runs slash commands against
 *     the agent's normal AGENTS.md context (skills + extensions loaded).
 *  2. Skills are NOT suppressed — slash commands like /mail-check may be
 *     implemented as pi skills; daydream suppresses them to keep footprint
 *     small, but scheduler sessions need the full command surface.
 *
 * Load context is bound to "daydream" so the spindle-memory extension
 * registers the store tool — scheduler commands need write access to memories.
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type AgentSession,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import { helperContextFiles, type SharedSessionDeps } from "../agent/session";
import { bindLoadContext } from "../memory/binding";
import { bindTelegramLoadContext } from "../channels/telegram/binding";
import { bindSessionKind } from "../agent/session-kind";
import type { EphemeralSession } from "../daydream/cycle";
import type { ScheduleEntry } from "./config";

export type SchedulerSessionFactory = (entry: ScheduleEntry) => Promise<EphemeralSession>;

export function createSchedulerSessionFactory(
  deps: SharedSessionDeps
): SchedulerSessionFactory {
  return async (entry: ScheduleEntry): Promise<EphemeralSession> => {
    // Same bind-before-reload ordering as the daydream factory — the
    // extension reads getLoadContext() during resourceLoader.reload(),
    // not inside createAgentSession.
    bindLoadContext("daydream");
    // "scheduler", not "daydream": scheduled commands may legitimately
    // send Telegram messages (reach-out, notify), so spindle-telegram
    // registers its outbound tools for this context. Observed failure
    // without this: a scheduled reach-out command's compose turn ran but
    // found no telegram_send_message tool and correctly sent nothing.
    bindTelegramLoadContext("scheduler");
    // The neutral session kind, for extensions core does not know about.
    // Without it a channel extension's "main session only" guard never
    // fires and the ephemeral session fully loads that extension — splicing
    // the channel's guide into the prompt and, worse, stealing the channel's
    // unsolicited handler so the MAIN session goes deaf to the channel's
    // events. In practice a scheduled mail check picked up a game channel's
    // context this way.
    bindSessionKind("scheduler");
    try {
      const resourceLoader = new DefaultResourceLoader({
        cwd: deps.agentDir,
        agentDir: deps.agentDir,
        settingsManager: deps.settingsManager,
        // Skills are intentionally NOT suppressed — scheduler sessions
        // need access to skill-based slash commands.
        ...(deps.noSkills ? { noSkills: true } : {}),
        ...(deps.noExtensions ? { noExtensions: true } : {}),
        // Per-entry opt-out of AGENTS.md/STATE.md. Needed by
        // commands that judge other agents: inheriting the host agent's
        // persona and operational state primes the judgement. Distill has
        // always done this; scheduler entries could not until now.
        // Otherwise the same AGENTS.md / CLAUDE.md choice as the main session.
        ...helperContextFiles(deps, { noContextFiles: entry.no_context_files === true }),
        ...(deps.extensionPaths.length > 0
          ? { additionalExtensionPaths: deps.extensionPaths }
          : {}),
      });
      await resourceLoader.reload();

      const sessionManager = SessionManager.inMemory();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sessionOptions: any = {
        cwd: deps.agentDir,
        modelRuntime: deps.modelRuntime,
        settingsManager: deps.settingsManager,
        sessionManager,
        // When entry.tools is set, restrict the session to that allowlist.
        // Don't pass tools: [] — an empty array disables all tools.
        // Omit the key entirely when no restriction is wanted.
        ...(entry.tools && entry.tools.length > 0 ? { tools: entry.tools } : {}),
        thinkingLevel: entry.thinking_level ?? "off",
        resourceLoader,
      };

      // Model resolution: per-entry model override takes priority over the
      // agent's main model. Resolve via ModelRuntime so provider/model
      // strings (e.g. "local/model") become full model defs.
      if (entry.model) {
        const [provider, ...modelParts] = entry.model.split("/");
        const modelId = modelParts.join("/");
        if (provider && modelId) {
          const resolved = deps.modelRuntime.getModel(provider, modelId) ?? undefined;
          if (resolved) {
            sessionOptions.model = resolved;
          } else {
            console.warn(
              `[scheduler] Model "${entry.model}" not found in registry — falling back to agent default`
            );
            if (deps.mainModel) sessionOptions.model = deps.mainModel;
          }
        } else {
          console.warn(
            `[scheduler] Invalid model format "${entry.model}" — expected "provider/model". Falling back to agent default`
          );
          if (deps.mainModel) sessionOptions.model = deps.mainModel;
        }
      } else if (deps.mainModel) {
        sessionOptions.model = deps.mainModel;
      }

      const { session, extensionsResult } = await createAgentSession(
        sessionOptions as CreateAgentSessionOptions
      );

      // An extension that FAILS TO LOAD in an ephemeral scheduled session must
      // say so. pi carries on with the extensions that worked and returns the
      // failures in extensionsResult.errors; the scheduler used to drop that
      // array on the floor, so a scheduled command whose handler never
      // registered looked identical to a working command. The symptom: a
      // scheduled slash command fell through to the LLM as plain text because
      // its command handler was never registered, and nothing in
      // scheduler.log said why. This mirrors the
      // main-session guard in src/agent/session.ts.
      for (const failure of extensionsResult?.errors ?? []) {
        console.error(
          `[scheduler] ============================================================\n` +
            `[scheduler] EXTENSION FAILED TO LOAD (entry "${entry.command}"): ${failure.path}\n` +
            `[scheduler]   ${failure.error}\n` +
            `[scheduler] The ephemeral session boots without it. Its tools,\n` +
            `[scheduler] commands and handlers silently do not happen — a slash\n` +
            `[scheduler] command whose handler is here will fall through to the\n` +
            `[scheduler] LLM as plain text.\n` +
            `[scheduler] ============================================================`
        );
      }

      return wrapEphemeral(session);
    } finally {
      bindLoadContext("main");
      bindTelegramLoadContext("main");
      bindSessionKind("main");
    }
  };
}

function wrapEphemeral(session: AgentSession): EphemeralSession {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = session as any;
  return {
    prompt: (text: string) => session.prompt(text),
    subscribe: (callback: (event: unknown) => void) =>
      session.subscribe(callback as Parameters<AgentSession["subscribe"]>[0]),
    close: () => {
      // Ephemeral sessions re-register every extension in the parent
      // process (fresh DefaultResourceLoader + reload()). Without dispose(),
      // each run leaks its command handlers and event listeners forever —
      // 1,202 accumulated registrations of one extension were measured in a
      // single agent process over 3.5 days.
      //
      // AgentSession.dispose() invalidates the extension runner, disconnects
      // from the agent and clears event listeners. It exists in
      // pi-coding-agent and spindle simply was not calling it.
      try {
        raw.dispose?.();
      } catch (err) {
        console.error("[scheduler] session dispose failed:", err);
      }
    },
    get systemPrompt() {
      try {
        return typeof raw.systemPrompt === "string" ? raw.systemPrompt : undefined;
      } catch {
        return undefined;
      }
    },
    get activeTools() {
      try {
        if (typeof raw.getActiveToolNames === "function") {
          const names = raw.getActiveToolNames();
          return Array.isArray(names) ? names : undefined;
        }
        if (Array.isArray(raw.activeTools)) return raw.activeTools;
        return undefined;
      } catch {
        return undefined;
      }
    },
    get isStreaming(): boolean {
      try {
        return typeof session.isStreaming === "boolean" ? session.isStreaming : false;
      } catch {
        return false;
      }
    },
  };
}
