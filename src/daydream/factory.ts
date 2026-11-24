/**
 * Daydream session factory — turns a `DaydreamPrompt` into a real
 * ephemeral pi session that can run one turn and be discarded.
 *
 * Architecture:
 *   - Reuses `SharedSessionDeps` from the main spindle session:
 *     same auth, same model registry, same settings, same extension
 *     paths (including spindle-memory)
 *   - Uses `SessionManager.inMemory()` so the cycle's conversation
 *     doesn't persist to disk
 *   - Injects the daydream's system prompt via a fresh
 *     `DefaultResourceLoader` with the `systemPrompt` option — this
 *     replaces whatever AGENTS.md-derived prompt the main session uses
 *   - Optionally switches to a different model via `config.model`,
 *     falling back to the main session's model
 *
 * The returned `EphemeralSession` wraps pi's AgentSession in the
 * minimal interface the cycle pipeline expects.
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
import { bindSessionKind } from "../agent/session-kind";
import type { DaydreamConfig } from "./types";
import type { EphemeralSession, EphemeralSessionFactory } from "./cycle";
import type { DaydreamPrompt } from "./prompt";

/**
 * Build a daydream session factory from the main spindle session's
 * shared dependencies. The returned function is passed to
 * `DaydreamRunner` / `runDaydreamCycle`.
 */
export function createDaydreamSessionFactory(
  deps: SharedSessionDeps,
  config: DaydreamConfig
): EphemeralSessionFactory {
  // Resolve the daydream model once at factory build time. If the
  // config specifies an override, look it up in the same model
  // registry the main session uses (so auth/keys are shared).
  let daydreamModel: CreateAgentSessionOptions["model"] | undefined;
  if (config.model) {
    const found = deps.modelRuntime.getModel(config.model.provider, config.model.model);
    if (found) {
      daydreamModel = found;
    } else {
      console.warn(
        `[spindle] daydream model ${config.model.provider}/${config.model.model} not found in registry — falling back to main session model`
      );
    }
  }
  const resolvedModel = daydreamModel ?? deps.mainModel;
  const thinkingLevel = config.model?.thinking_level ?? "off";

  return async (prompt: DaydreamPrompt): Promise<EphemeralSession> => {
    // Critical ordering: bind the load context to 'daydream' BEFORE
    // building the resourceLoader, because the extension's default
    // export runs inside `resourceLoader.reload()` (not inside
    // `createAgentSession`). The extension reads getLoadContext() at
    // that moment to decide whether to register the store tool — if
    // we bind after reload, the extension sees 'main' and correctly
    // withholds store, which is the wrong decision for the daydream
    // cycle and means nothing gets written.
    //
    // Discovered during Phase 5 E2E: with the context bind happening
    // after reload, daydream cycles stored 0 because the extension
    // registered recall-only for the ephemeral session too.
    //
    // The runner's single-cycle-in-flight guarantee means no other
    // code path will observe the 'daydream' context between the bind
    // here and the final restore in the finally block.
    bindLoadContext("daydream");
    // Keep channel extensions out of daydream sessions — same rationale as
    // the scheduler factory: a channel's session-kind binding defaults to
    // "main", so without this the daydream session would load the channel's
    // tools and steal its unsolicited handler from the main session.
    bindSessionKind("daydream");
    try {
      // Each cycle gets a fresh resourceLoader so the prompt additions
      // are isolated to this one ephemeral session. The main session's
      // loader is untouched.
      //
      // We APPEND the curator instructions to pi's computed base
      // system prompt via `appendSystemPrompt`, instead of replacing
      // the whole thing with `systemPromptOverride`. Rationale:
      //   - Pi's base prompt includes critical structural content: the
      //     "You are an expert coding assistant" framing, the
      //     `Available tools:` prose list (which some providers need
      //     even when tools are passed structurally), the guidelines
      //     section, etc. Blowing it all away leaves Qwen without a
      //     clear tool surface and the LLM can silently produce empty
      //     turns.
      //   - The agent's AGENTS.md is loaded by pi's default prompt
      //     builder as part of the context files section, not the
      //     base prompt. Leaving the base alone preserves tools/
      //     framing but still picks up AGENTS.md — which for
      //     eliza-memory is now minimal personality content, so it
      //     doesn't contradict the daydream's intent.
      //   - If agents do have AGENTS.md content that conflicts with
      //     daydream (e.g. "don't use memory tools"), the curator
      //     instructions come LAST in the appended prompt so they
      //     have recency bias, and future work can remove AGENTS.md
      //     from daydream loads specifically if needed.
      //
      // `noSkills: true` and `noPromptTemplates: true` keep the
      // daydream's token footprint small and its tool surface focused.
      const resourceLoader = new DefaultResourceLoader({
        cwd: deps.agentDir,
        agentDir: deps.agentDir,
        settingsManager: deps.settingsManager,
        appendSystemPrompt: [prompt.systemPrompt],
        noSkills: true,
        noPromptTemplates: true,
        // The same AGENTS.md / CLAUDE.md choice as the main session.
        ...helperContextFiles(deps),
        ...(deps.noExtensions ? { noExtensions: true } : {}),
        ...(deps.extensionPaths.length > 0
          ? { additionalExtensionPaths: deps.extensionPaths }
          : {}),
      });
      await resourceLoader.reload();

      // In-memory session manager — no disk persistence, no clutter
      // in ~/.pi/agent/sessions/. The ephemeral session exists for
      // the duration of one turn and is then garbage collected.
      const sessionManager = SessionManager.inMemory();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sessionOptions: any = {
        cwd: deps.agentDir,
        modelRuntime: deps.modelRuntime,
        settingsManager: deps.settingsManager,
        sessionManager,
        tools: deps.tools,
        thinkingLevel,
        resourceLoader,
      };
      if (resolvedModel) sessionOptions.model = resolvedModel;

      const { session } = await createAgentSession(
        sessionOptions as CreateAgentSessionOptions
      );
      return wrapEphemeral(session);
    } finally {
      bindLoadContext("main");
      bindSessionKind("main");
    }
  };
}

function wrapEphemeral(session: AgentSession): EphemeralSession {
  // Narrow the session to the shape we actually read. Pi exposes
  // systemPrompt as a getter and (sometimes) activeTools — we forward
  // both through the wrapper so the cycle's debug mode can log them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = session as any;
  return {
    prompt: (text: string) => session.prompt(text),
    subscribe: (callback: (event: unknown) => void) =>
      session.subscribe(callback as Parameters<AgentSession["subscribe"]>[0]),
    close: () => {
      // Dropping the reference is NOT sufficient cleanup.
      // Each ephemeral session re-registers every extension in the parent
      // process via its own DefaultResourceLoader + reload(); the resulting
      // command handlers and event listeners survive until dispose().
      //
      // AgentSession.dispose() invalidates the extension runner, disconnects
      // from the agent and clears event listeners. It exists in
      // pi-coding-agent and spindle simply was not calling it.
      try {
        raw.dispose?.();
      } catch (err) {
        console.error("[daydream] session dispose failed:", err);
      }
    },
    get systemPrompt() {
      try {
        return typeof raw.systemPrompt === "string"
          ? raw.systemPrompt
          : undefined;
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
  };
}
