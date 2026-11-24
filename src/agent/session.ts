import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { readMainSessionMarker, readMainSessionPin, writeMainSessionMarker } from "./marker";

/**
 * Expand a single load_extensions entry into one or more extension paths.
 *
 * If the resolved path is a directory that looks like an extension itself
 * (contains index.ts or index.js), return it as-is. If it looks like a
 * container directory (no index file at the root), enumerate its immediate
 * subdirectories that have an index file — treating it as a glob of all
 * extensions in that folder.
 *
 * This lets agent.yaml say `load_extensions: [.pi/extensions]` instead of
 * listing every extension individually.
 */
function expandExtensionPath(resolved: string): string[] {
  let isDir: boolean;
  try {
    isDir = statSync(resolved).isDirectory();
  } catch {
    // Pass it through so pi reports it too, but say so here where it
    // is impossible to miss: an agent once ran for two hours with no idle
    // nudges because its idle-nudge extension directory had gone (an
    // untracked file lost to a git revert) and nothing at boot said a word.
    console.error(
      `[spindle] ============================================================\n` +
        `[spindle] load_extensions entry NOT FOUND: ${resolved}\n` +
        `[spindle] The agent boots without it. Whatever that extension did\n` +
        `[spindle] (nudges, tools, commands) will silently not happen.\n` +
        `[spindle] ============================================================`
    );
    return [resolved];
  }

  if (!isDir) return [resolved]; // explicit file path

  // Directory with its own index = a single extension
  if (
    existsSync(join(resolved, "index.ts")) ||
    existsSync(join(resolved, "index.js"))
  ) {
    return [resolved];
  }

  // Container directory — enumerate immediate subdirs that look like extensions
  try {
    return readdirSync(resolved)
      .map((name) => join(resolved, name))
      .filter((sub) => {
        try {
          if (!statSync(sub).isDirectory()) return false;
          return (
            existsSync(join(sub, "index.ts")) ||
            existsSync(join(sub, "index.js"))
          );
        } catch {
          return false;
        }
      });
  } catch {
    return [resolved];
  }
}
import {
  createAgentSession,
  type CreateAgentSessionOptions,
  type AgentSession,
  type SlashCommandInfo,
  SessionManager,
  ModelRuntime,
  SettingsManager,
  DefaultResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../types";
import { bindSpeechSettings } from "../speech/binding";
import { resolveSpeechSettings } from "../speech/config";

/**
 * Find the most recently modified `.jsonl` session file in a directory.
 * Mirrors pi's internal `findMostRecentSession` helper (which isn't re-
 * exported from the public SDK surface). Returns null if the directory
 * doesn't exist, is unreadable, or contains no session files.
 */
export function findMostRecentSession(sessionDir: string): string | null {
  try {
    const files = readdirSync(sessionDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(sessionDir, f))
      .map((path) => ({ path, mtime: statSync(path).mtime }))
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    return files[0]?.path ?? null;
  } catch {
    return null;
  }
}

/**
 * Resume mode for spindle session creation.
 *
 * - "new":      Always start a fresh session (default)
 * - "main":     Pin to a designated session via sidecar marker
 * - "continue": Load the most recent session file from sessionDir
 * - {path}:     Load a specific session file path
 *
 * CLI flags override agent.yaml values; agent.yaml values override the
 * default.
 */
export type ResumeMode = "new" | "continue" | "main" | { path: string };

export interface CreateSpindleSessionOptions {
  /** CLI-level override of the resume mode. Takes precedence over agent.yaml. */
  resumeOverride?: ResumeMode;
  /** pi extension paths contributed by the configured channels. */
  channelExtensionPaths?: readonly string[];
}

/**
 * Pure function: builds a partial options bag from agent config.
 * The `model` field is a "provider/model_id" string for display/config;
 * actual Model resolution happens in createSpindleSession.
 */
export interface SessionBuildResult {
  cwd: string;
  model: string | undefined;
  thinkingLevel: CreateAgentSessionOptions["thinkingLevel"];
}

export function buildSessionOptions(
  config: AgentConfig,
  agentDir: string
): SessionBuildResult {
  const pi = config.pi;
  const model =
    pi?.provider && pi?.model
      ? `${pi.provider}/${pi.model}`
      : undefined;

  return {
    cwd: agentDir,
    model,
    thinkingLevel: pi?.thinking_level ?? "off",
  };
}

/**
 * Apply `pi.tools` — which of pi's built-in tools (read, bash, edit,
 * write, ...) the agent starts with.
 *
 * Unset: pi's default. A list: exactly those; `[]` means none. Tools that
 * extensions register are not affected either way.
 *
 * pi takes this from its `defaultTools` setting, so the answer is put on
 * the settings manager the session is built from — and so applies to
 * every helper session built from the same one. Three things it is NOT,
 * each tried or considered:
 *
 *   - createAgentSession's `tools` option. That is an allowlist over ALL
 *     tools and would switch off every extension tool not named in it.
 *   - an option called `initialActiveToolNames`. pi does not read one;
 *     passing it did nothing, and for a long time every agent started
 *     with pi's four defaults whatever its config said.
 *   - `settingsManager.applyOverrides({ defaultTools })`. pi's resource
 *     loader reloads the settings manager from disk before the session
 *     reads it, which discards overrides.
 *
 * So the manager's own getter is replaced on this one instance. Nothing
 * is written to any settings file.
 */
export function applyBuiltinToolChoice(
  settingsManager: Pick<SettingsManager, "getDefaultTools">,
  tools: readonly unknown[] | undefined,
): string[] | undefined {
  if (tools === undefined) return undefined;
  const names = tools.map((n) => String(n));
  settingsManager.getDefaultTools = () => [...names];
  return names;
}

/**
 * Resolve extension paths from config + spindle's built-in extensions.
 * Paths in `load_extensions` are relative to the agent directory.
 * Built-in extensions (like spindle-memory) are resolved relative to
 * spindle's own source tree via `import.meta.url`.
 */
function resolveExtensionPaths(
  config: AgentConfig,
  agentDir: string,
  channelExtensionPaths: readonly string[] = [],
): string[] {
  const paths: string[] = [];
  const sessionDir = dirname(fileURLToPath(import.meta.url));

  // Built-in spindle-provenance extension, always injected and always
  // FIRST: its before_agent_start resolves who owns the run, and later
  // extensions (a channel extension's tool scoping) read that decision. pi
  // runs handlers in extension load order.
  paths.push(resolve(sessionDir, "..", "extensions", "spindle-provenance"));

  // Built-in spindle-memory extension, auto-injected when memory is enabled.
  // Pi's loader will pick up the default export from its index.ts.
  if (config.memory?.enabled) {
    // session.ts lives in src/agent/, extension lives in src/extensions/spindle-memory/
    const builtIn = resolve(sessionDir, "..", "extensions", "spindle-memory");
    paths.push(builtIn);
  }

  // Built-in spindle-inbox extension, auto-injected when inbox is enabled.
  if (config.inbox?.enabled) {
    const builtIn = resolve(sessionDir, "..", "extensions", "spindle-inbox");
    paths.push(builtIn);
  }

  // Extensions the configured channels bring with them, in channel start
  // order (channels/registry.ts). Each channel plugin decides its own.
  paths.push(...channelExtensionPaths);

  // Built-in spindle-speak extension, auto-injected when speech is
  // enabled. Publishes the resolved settings to the process-wide binding
  // first: the extension reads them at register time, which happens
  // inside createAgentSession below.
  const speechSettings = resolveSpeechSettings(config, agentDir);
  bindSpeechSettings(speechSettings);
  if (speechSettings) {
    const builtIn = resolve(sessionDir, "..", "extensions", "spindle-speak");
    paths.push(builtIn);
  }

  // User-configured extension paths (relative to the agent directory).
  // Each entry is either an explicit extension path or a container directory
  // whose subdirectories are enumerated as extensions (see expandExtensionPath).
  const fromConfig = config.pi?.load_extensions;
  if (fromConfig && fromConfig.length > 0) {
    for (const p of fromConfig) {
      paths.push(...expandExtensionPath(resolve(agentDir, p)));
    }
  }

  return paths;
}

/**
 * Translates `pi.context_files` into the subset of
 * `DefaultResourceLoader` options that controls AGENTS.md / CLAUDE.md
 * loading. Returns `undefined` for the default "auto" mode (or when
 * the field is omitted), so the caller can skip wiring an override.
 */
export interface ContextFilesOptions {
  noContextFiles?: boolean;
  agentsFilesOverride?: (base: {
    agentsFiles: Array<{ path: string; content: string }>;
  }) => { agentsFiles: Array<{ path: string; content: string }> };
}

export function resolveContextFilesOptions(
  mode: "auto" | "agent_dir_only" | "none" | string[] | undefined,
  agentDir: string
): ContextFilesOptions | undefined {
  if (mode === "auto") return undefined;
  if (mode === "none") return { noContextFiles: true };
  if (mode === undefined || mode === "agent_dir_only") {
    return {
      agentsFilesOverride: ({ agentsFiles }) => ({
        agentsFiles: agentsFiles.filter((f) => dirname(f.path) === agentDir),
      }),
    };
  }
  // Explicit list — resolved relative to agentDir, read at boot.
  const explicit: Array<{ path: string; content: string }> = [];
  for (const rel of mode) {
    const abs = resolve(agentDir, rel);
    if (!existsSync(abs)) {
      console.warn(`[spindle] pi.context_files entry not found: ${abs}`);
      continue;
    }
    try {
      explicit.push({ path: abs, content: readFileSync(abs, "utf-8") });
    } catch (err) {
      console.warn(`[spindle] failed to read pi.context_files entry ${abs}: ${err}`);
    }
  }
  return { agentsFilesOverride: () => ({ agentsFiles: explicit }) };
}

/**
 * Dependencies shared between the main spindle session and any
 * ephemeral pi sessions that need to run alongside it (e.g. Phase 5's
 * daydream loop). Same auth, same models, same extension paths — only
 * the SessionManager and systemPrompt differ per-session.
 */
export interface SharedSessionDeps {
  // pi 0.84 unified auth + model resolution behind ModelRuntime; it
  // replaces the AuthStorage/ModelRegistry pair these deps used to carry.
  modelRuntime: ModelRuntime;
  settingsManager: SettingsManager;
  extensionPaths: string[];
  mainModel: CreateAgentSessionOptions["model"] | undefined;
  agentDir: string;
  noExtensions: boolean;
  noSkills: boolean;
  tools: unknown[];
  /**
   * How AGENTS.md / CLAUDE.md files are chosen, as resolved from
   * `pi.context_files` for the main session. Helper sessions apply the
   * same choice (helperContextFiles). Undefined means pi's own default:
   * every such file from the agent directory up to the filesystem root.
   */
  contextFiles?: ContextFilesOptions;
}

/**
 * The context-file options for a helper session built beside the main
 * one: whatever the main session uses, unless this one session asks for
 * none at all.
 *
 * A helper session that skipped this got pi's default instead — every
 * AGENTS.md and CLAUDE.md from the agent directory up to `/`. An agent
 * kept in a sub-folder of a project then had that project's instructions
 * for coding agents in its system prompt in every scheduled, daydream
 * and one-off session, though not in its main one.
 */
export function helperContextFiles(
  deps: Pick<SharedSessionDeps, "contextFiles">,
  options: { noContextFiles?: boolean } = {},
): ContextFilesOptions {
  if (options.noContextFiles) return { noContextFiles: true };
  return deps.contextFiles ?? {};
}

export interface SpindleSession {
  /** The live pi-agent session. */
  session: AgentSession;
  /** Returns extension/skill slash commands discovered by pi at boot. */
  getSlashCommands: () => SlashCommandInfo[];
  /** Optional message if pi fell back to a different model than requested. */
  modelFallbackMessage?: string;
  /**
   * Shared dependencies for spawning ephemeral sessions. Phase 5's
   * daydream factory captures these to reuse auth + model + extensions
   * without re-initializing the whole stack per cycle.
   */
  dependencies: SharedSessionDeps;
}

/**
 * Create a fully configured pi-agent session from spindle config.
 * Supports all pi options from agent.yaml: tools, extensions, skills,
 * model, provider, system_prompt, session_dir.
 */
export async function createSpindleSession(
  config: AgentConfig,
  agentDir: string,
  spindleOptions: CreateSpindleSessionOptions = {}
): Promise<SpindleSession> {
  const options = buildSessionOptions(config, agentDir);
  const pi = config.pi;

  const modelRuntime = await ModelRuntime.create();
  const settingsManager = SettingsManager.create(agentDir);

  // Resolve model from registry if provider/model was specified
  let resolvedModel: CreateAgentSessionOptions["model"] | undefined;
  if (options.model) {
    const [provider, ...modelParts] = options.model.split("/");
    const modelId = modelParts.join("/"); // model IDs can contain slashes
    if (provider && modelId) {
      resolvedModel = modelRuntime.getModel(provider, modelId) ?? undefined;
    }
  }

  // Resolve session directory
  const sessionDir = pi?.session_dir
    ? resolve(agentDir, pi.session_dir)
    : undefined;

  // Resolve resume mode and build the SessionManager upfront.
  // Pi 0.70 removed AgentSession.switchSession — the only supported way
  // to load prior history is to pass a SessionManager.open(path) at
  // creation time, before createAgentSession is called.
  const resumeMode = resolveResumeMode(config, spindleOptions.resumeOverride);
  const sessionManager = buildSessionManager(resumeMode, agentDir, sessionDir);

  // Resolve tools
  const builtinTools = applyBuiltinToolChoice(settingsManager, config.pi?.tools);
  if (builtinTools) {
    console.log(`[spindle] built-in tools: ${builtinTools.length > 0 ? builtinTools.join(", ") : "(none)"}`);
  }

  // Build resourceLoader with extension control
  const extensionPaths = resolveExtensionPaths(config, agentDir, spindleOptions.channelExtensionPaths);
  const noExtensions = pi?.extensions === false;
  const noSkills = pi?.skills === false;
  const contextFilesOpts = resolveContextFilesOptions(pi?.context_files, agentDir);

  // Build session options
  const sessionOptions: Partial<CreateAgentSessionOptions> = {
    cwd: agentDir,
    modelRuntime,
    settingsManager,
    sessionManager,
    ...(resolvedModel ? { model: resolvedModel } : {}),
    thinkingLevel: options.thinkingLevel,
  };

  // Handle extension/skill control and explicit extension loading
  // Pi's createAgentSession accepts these via the resourceLoader
  if (
    noExtensions ||
    noSkills ||
    extensionPaths.length > 0 ||
    contextFilesOpts !== undefined
  ) {
    const resourceLoader = new DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      settingsManager,
      ...(noExtensions ? { noExtensions: true } : {}),
      ...(noSkills ? { noSkills: true } : {}),
      ...(extensionPaths.length > 0
        ? { additionalExtensionPaths: extensionPaths }
        : {}),
      ...(contextFilesOpts ?? {}),
    });
    await resourceLoader.reload();
    (sessionOptions as any).resourceLoader = resourceLoader;
  }

  // Handle system prompt override
  if (pi?.system_prompt) {
    (sessionOptions as any).systemPrompt = pi.system_prompt;
  }

  const { session, extensionsResult, modelFallbackMessage } = await createAgentSession(
    sessionOptions as CreateAgentSessionOptions
  );
  // An extension that FAILS TO LOAD must say so. pi returns the failures in
  // extensionsResult.errors and carries on with the ones that worked; spindle
  // used to drop that array on the floor, so a broken extension looked exactly
  // like a working one that had nothing to do. In practice a third-party
  // extension threw on import and the only visible symptom was its slash
  // commands quietly not existing.
  //
  // Same reasoning as the missing-path warning in expandExtensionPath above,
  // and the same shape of loss — whatever the extension did just silently
  // does not happen.
  for (const failure of extensionsResult?.errors ?? []) {
    console.error(
      `[spindle] ============================================================\n` +
        `[spindle] EXTENSION FAILED TO LOAD: ${failure.path}\n` +
        `[spindle]   ${failure.error}\n` +
        `[spindle] The agent boots without it. Its tools, commands and\n` +
        `[spindle] handlers will silently not happen.\n` +
        `[spindle] ============================================================`
    );
  }

  // Explicitly log which model pi actually loaded. Pi will silently fall back
  // to a different model when the configured one can't be resolved (typo) or
  // has no working auth, and neither the agent nor the operator can otherwise
  // tell. `session.model` reflects the real model after any fallback, whereas
  // `options.model` / `resolvedModel` reflect what was *requested*.
  {
    const requested = options.model ?? "(none — pi default)";
    const active = session.model
      ? `${session.model.provider}/${session.model.id}`
      : "(no model loaded)";
    const activeName = session.model?.name ?? "?";
    const activeBaseUrl = session.model?.baseUrl ?? "?";
    if (!resolvedModel && options.model) {
      console.warn(
        `[spindle] model: requested "${requested}" did NOT resolve in the registry (typo or missing auth) — pi chose a fallback`
      );
    }
    if (!session.model) {
      console.error(`[spindle] model: no model loaded for requested "${requested}"`);
    } else if (resolvedModel && active !== requested) {
      console.warn(
        `[spindle] model: requested "${requested}" but pi loaded "${active}" (fallback) — ${activeName} @ ${activeBaseUrl}`
      );
    } else {
      console.log(
        `[spindle] model: loaded "${active}" (${activeName} @ ${activeBaseUrl})`
      );
    }
    if (modelFallbackMessage) {
      console.warn(`[spindle] model: pi fallback note — ${modelFallbackMessage}`);
    }
  }

  // Deferred main-session marker write: when main_session created a fresh
  // session (no prior sessions existed), the marker couldn't be written in
  // buildSessionManager because the file path wasn't known yet.  Now that
  // createAgentSession has initialized the SessionManager, the file exists.
  if (resumeMode === "main") {
    const resolvedDir = sessionDir ?? sessionManager.getSessionDir();
    // Written even though pi has not created the file yet: the pin is the
    // path, and openPinnedMainSession starts the session there next time.
    if (!readMainSessionPin(resolvedDir)) {
      const filePath = sessionManager.getSessionFile();
      if (filePath) {
        writeMainSessionMarker(resolvedDir, filePath);
        console.log(`[spindle] main_session: marker written → ${filePath}`);
      }
    }
  }

  // Pi-agent only wires runtime.getCommands to a real implementation when
  // an extension runner is created (i.e. when there are extensions or
  // custom tools). Without that, calling getCommands() throws
  // "Extension runtime not initialized". Wrap the call so a commands-less
  // agent degrades silently to an empty list instead of a runtime error.
  const getSlashCommands = (): SlashCommandInfo[] => {
    try {
      return extensionsResult?.runtime?.getCommands?.() ?? [];
    } catch {
      return [];
    }
  };

  return {
    session,
    getSlashCommands,
    modelFallbackMessage,
    dependencies: {
      modelRuntime,
      settingsManager,
      extensionPaths,
      mainModel: resolvedModel,
      agentDir,
      noExtensions,
      noSkills,
      tools: [],
      ...(contextFilesOpts !== undefined ? { contextFiles: contextFilesOpts } : {}),
    },
  };
}

/**
 * Collapse agent.yaml + CLI override into a single resume directive.
 * Precedence (highest → lowest):
 *   1. CLI override (options.resumeOverride)
 *   2. agent.yaml `pi.main_session: true` (pinned via sidecar marker)
 *   3. agent.yaml `pi.resume_session` (explicit path)
 *   4. agent.yaml `pi.continue_session: true`
 *   5. default "new"
 *
 * Migration: If `main_session: true` is set but no marker exists,
 * spindle adopts the most recent session and writes the marker.
 * This allows seamless migration from `continue_session: true`.
 */
export function resolveResumeMode(
  config: AgentConfig,
  override?: ResumeMode
): ResumeMode {
  if (override !== undefined) return override;
  const pi = config.pi;
  if (pi?.main_session) return "main";
  if (pi?.resume_session) return { path: pi.resume_session };
  if (pi?.continue_session) return "continue";
  return "new";
}
/**
 * Build a SessionManager for the given resume mode.
 *
 * Pi 0.70 removed AgentSession.switchSession. The only supported path
 * for loading prior history is passing a SessionManager.open(file) to
 * createAgentSession at construction time.
 *
 * - "new"      → SessionManager.create (fresh session)
 * - "main"     → Pin to a designated session via sidecar marker
 * - "continue" → SessionManager.open(most-recent file in sessionDir)
 * - {path}     → SessionManager.open(explicit file)
 *
 * Falls back to a fresh SessionManager when the target file is missing
 * or the session dir has no prior sessions.
 */
/**
 * Open the session the marker in `sessionDir` pins, or return null when
 * there is no marker.
 *
 * A pin whose file is not there is still honoured. The usual reason is
 * that the main session has never had anything to save — pi writes a
 * session's file with its first entry — and other sessions (a channel's
 * one-off sessions, kept in the same folder) have. Treating that pin as
 * "no marker" adopted the newest file in the folder as the main session,
 * which was one of those. Instead the pinned path becomes a session: an
 * empty file is put there, and pi, opening an empty file, writes a fresh
 * session into it. The path then exists and the pin holds from then on.
 */
function openPinnedMainSession(sessionDir: string): SessionManager | null {
  const pin = readMainSessionPin(sessionDir);
  if (!pin) return null;
  if (pin.exists) {
    console.log(`[spindle] main_session: resuming pinned session: ${pin.path}`);
    return SessionManager.open(pin.path, sessionDir);
  }
  console.log(`[spindle] main_session: pinned session has no file yet, starting it at its pinned path: ${pin.path}`);
  mkdirSync(dirname(pin.path), { recursive: true });
  writeFileSync(pin.path, "", { flag: "a" });
  return SessionManager.open(pin.path, sessionDir);
}

export function buildSessionManager(
  mode: ResumeMode,
  agentDir: string,
  sessionDir: string | undefined
): SessionManager {
  const makeNew = () =>
    sessionDir
      ? SessionManager.create(agentDir, sessionDir)
      : SessionManager.create(agentDir);

  if (mode === "new") {
    return makeNew();
  }


  if (mode === "main") {
    // When sessionDir is unset, we can't directly resolve the default
    // session dir (pi doesn't export getDefaultSessionDir). Instead,
    // use SessionManager.continueRecent which internally resolves the
    // default dir and finds the most recent session.
    if (!sessionDir) {
      const mgr = SessionManager.continueRecent(agentDir);
      const sessionFile = mgr.getSessionFile();
      if (sessionFile) {
        const resolvedDir = mgr.getSessionDir();
        const pinned = openPinnedMainSession(resolvedDir);
        if (pinned) return pinned;
        // No marker — adopt whatever continueRecent found
        console.log(`[spindle] main_session: adopting session as main: ${sessionFile}`);
        writeMainSessionMarker(resolvedDir, sessionFile);
      } else {
        console.log(`[spindle] main_session: no prior sessions, creating fresh`);
        // mgr is already a fresh session; marker written post-creation
      }
      return mgr;
    }

    // Explicit sessionDir — full marker logic
    const pinned = openPinnedMainSession(sessionDir);
    if (pinned) return pinned;

    // No marker — adopt most recent session if one exists (migration path)
    const mostRecent = findMostRecentSession(sessionDir);
    if (mostRecent) {
      console.log(
        `[spindle] main_session: no marker found, adopting most recent: ${mostRecent}`
      );
      writeMainSessionMarker(sessionDir, mostRecent);
      return SessionManager.open(mostRecent, sessionDir);
    }

    // No sessions at all — create fresh and mark it
    console.log(`[spindle] main_session: no prior sessions, creating new main session`);
    const mgr = SessionManager.create(agentDir, sessionDir);
    // Marker write deferred — file path may not exist until first persist.
    return mgr;
  }
  if (typeof mode === "object" && "path" in mode) {
    const targetPath = resolve(mode.path);
    if (!existsSync(targetPath)) {
      console.warn(
        `[spindle] resume_session: file not found at ${targetPath}. Starting fresh.`
      );
      return makeNew();
    }
    console.log(`[spindle] resuming session: ${targetPath}`);
    return SessionManager.open(targetPath, sessionDir);
  }

  // mode === "continue"
  // When session_dir is unset, defer to pi's continueRecent which resolves
  // the default global location (~/.pi/agent/sessions/<encoded-cwd>/).
  // Substituting a local <agentDir>/.pi/sessions fallback here causes
  // spindle to silently pick up stray local sessions and keep writing
  // there, drifting away from pi's default.
  if (!sessionDir) {
    console.log(
      `[spindle] continue_session: deferring to pi default session dir`
    );
    return SessionManager.continueRecent(agentDir);
  }
  const targetPath = findMostRecentSession(sessionDir);
  if (!targetPath) {
    console.log(
      `[spindle] continue_session: no prior session in ${sessionDir}. Starting fresh.`
    );
    return makeNew();
  }
  console.log(`[spindle] continuing session: ${targetPath}`);
  return SessionManager.open(targetPath, sessionDir);
}
