#!/usr/bin/env bun
import { resolve } from "path";
import { existsSync } from "fs";
import { loadAgentConfig, resolveAgentDir } from "./config/loader";
import { createSpindleSession, type ResumeMode, type SharedSessionDeps } from "./agent/session";
import { createTurnTracker, waitForIdle } from "./agent/events";
import { consumePlannedAbort, markPlannedAbort } from "./agent/planned-abort";
import { installStopAfterTurn } from "./agent/stop-after-turn";
import type { Channel } from "./channels/types";
import { ProvenanceTracker, origin } from "./provenance/tracker";
import { bindProvenanceTracker } from "./provenance/binding";
import { bindMediaLog, MediaLog } from "./media/log";
import { bindOutboundLog, OutboundLog } from "./outbound";
import { BUILTIN_CHANNEL_PLUGINS } from "./channels/builtin";
import {
  assertUniqueKeys,
  channelLogName,
  createChannels,
  unclaimedChannelKeys,
  type ChannelHost,
} from "./channels/registry";
import { loadPlugins, publishApi } from "./plugins/loader";
import * as spindleApi from "./api";
import { registerKnownToolNames } from "./util/fake-tool-calls";
import { MemoryEngine } from "./memory/engine";
import {
  bindMemoryEngine,
  bindMemoryAgentId,
  bindDaydreamActive,
  bindMainStoreEnabled,
} from "./memory/binding";
import { AgentStateWriter } from "./state/writer";
import { DaydreamRunner } from "./daydream/runner";
import { createDaydreamSessionFactory } from "./daydream/factory";
import { InboxEngine } from "./inbox/engine";
import { InboxProjector } from "./inbox/projector";
import { resolveInboxConfig } from "./inbox/config";
import {
  bindInboxEngine,
  bindInboxAgentId,
} from "./inbox/binding";
import {
  resolveWebConfig,
  createWebServer,
  type WebServerHandle,
} from "./web/server";
import { createSpindleRuntime } from "./extensions/runtime";
import { createWorkerDispatcher } from "./extensions/worker-dispatch";
import { loadSpindleExtensions } from "./extensions/loader";
import { SessionIngester } from "./sessions/ingester";
import { ContextTelemetryRecorder } from "./telemetry/recorder";
import { bindTelemetryRecorder } from "./telemetry/binding";
import { openTelemetryDb } from "./telemetry/db";
import { CompactNudgeRunner } from "./compact/runner";
import { resolveContextLimit } from "./compact/config";
import { SchedulerRunner } from "./scheduler/runner";
import { bindShutdownSignal } from "./shutdown/binding";
import { armShutdownWatchdog } from "./shutdown/watchdog";
import { dirname, join } from "path";

const SPINDLE_VERSION = "0.4.1";

interface ParsedArgs {
  command: string;
  agentPath: string;
  resumeOverride?: ResumeMode;
}

function printUsageAndExit(): never {
  console.error("Usage: spindle run [options] <agent-directory>");
  console.error("");
  console.error("Options:");
  console.error("  -c, --continue           Resume the most recent session");
  console.error("  --resume <session.jsonl> Resume a specific session file");
  console.error("");
  console.error("Examples:");
  console.error("  spindle run ./examples/eliza");
  console.error("  spindle run -c ./examples/eliza");
  console.error("  spindle run --resume ~/.pi/agent/sessions/foo/2026-04-11.jsonl ./examples/eliza");
  process.exit(1);
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  if (args.length === 0) printUsageAndExit();

  // Drop a leading "run" subcommand so both `spindle run X` and `spindle X` work.
  const rest = args[0] === "run" ? args.slice(1) : args.slice(0);

  let resumeOverride: ResumeMode | undefined;
  const positional: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "-c" || arg === "--continue") {
      resumeOverride = "continue";
    } else if (arg === "--resume") {
      const path = rest[i + 1];
      if (!path) {
        console.error("--resume requires a session file path");
        printUsageAndExit();
      }
      resumeOverride = { path };
      i++;
    } else if (arg === "--new") {
      // Explicit "start fresh" override, useful when agent.yaml has continue_session: true
      resumeOverride = "new";
    } else if (arg.startsWith("--") || arg.startsWith("-")) {
      console.error(`Unknown flag: ${arg}`);
      printUsageAndExit();
    } else {
      positional.push(arg);
    }
  }

  if (positional.length === 0) printUsageAndExit();
  if (positional.length > 1) {
    console.error(`Expected one agent directory, got: ${positional.join(", ")}`);
    printUsageAndExit();
  }

  return { command: "run", agentPath: positional[0], resumeOverride };
}

async function main() {
  const { agentPath, resumeOverride } = parseArgs();

  // Bind the shutdown signal early so extensions that import it at module
  // load time get a live signal. Aborted in the shutdown handler below.
  const shutdownController = new AbortController();
  bindShutdownSignal(shutdownController.signal);

  const agentDir = resolve(agentPath);

  if (!existsSync(agentDir)) {
    console.error(`Agent directory not found: ${agentDir}`);
    process.exit(1);
  }

  // Chdir into the agent directory so extensions that use process.cwd()
  // at module-load time resolve their `.pi/memory/*`, AGENTS.md,
  // and skills paths against the agent — not wherever the operator
  // launched spindle from. This matches the historical pi-agent
  // convention of running from the agent directory and keeps
  // `spindle run <path>` behaviorally equivalent to `cd <path> && spindle run .`
  //
  // Must happen BEFORE loadAgentConfig / createSpindleSession so extensions
  // see the right cwd during their initial import.
  process.chdir(agentDir);

  // Load and validate config
  const configResult = loadAgentConfig(agentDir);
  if (!configResult.success) {
    console.error("Invalid agent.yaml:");
    configResult.errors.forEach((e) => console.error(`  - ${e}`));
    process.exit(1);
  }

  const config = configResult.data;
  const dirs = resolveAgentDir(agentDir);

  console.log(`[spindle] Loading agent: ${config.agent.name ?? config.agent.id}`);
  console.log(`[spindle] Agent dir: ${dirs.agentDir}`);
  console.log(`[spindle] Pi dir: ${dirs.piDir}`);

  // Open the memory engine BEFORE the pi session so the spindle-memory
  // extension sees the binding when it loads. Setting both bindings is
  // how the module-level singleton pattern works (see src/memory/binding.ts
  // and src/extensions/spindle-memory/index.ts).
  let memoryEngine: MemoryEngine | null = null;
  if (config.memory?.enabled) {
    try {
      memoryEngine = await MemoryEngine.open(config.memory, process.env, agentDir);
      memoryEngine.registerAgent(config.agent.id, config.agent.name);
      bindMemoryEngine(memoryEngine);
      bindMemoryAgentId(config.agent.id);
      const daydreamEnabled = Boolean(config.memory.daydream?.enabled);
      bindDaydreamActive(daydreamEnabled);
      // Main session store-tool registration — explicit config wins,
      // otherwise default is "opposite of daydream" (daydream off →
      // main stores directly; daydream on → main is recall-only).
      const mainStoreEnabled =
        config.memory.main_session_store_tool ?? !daydreamEnabled;
      bindMainStoreEnabled(mainStoreEnabled);
      const embStatus = memoryEngine.hasEmbeddings ? "with embeddings" : "FTS5 only";
      console.log(`[spindle] Memory engine opened (${embStatus})`);
    } catch (err) {
      console.error(
        `[spindle] Failed to open memory engine: ${err instanceof Error ? err.message : String(err)}`
      );
      console.error("[spindle] Continuing without memory tools");
      memoryEngine = null;
      bindMemoryEngine(null);
      bindMemoryAgentId(null);
      bindDaydreamActive(false);
      bindMainStoreEnabled(true);
    }
  }

  // Open the inbox engine AFTER memory but BEFORE createSpindleSession
  // so the spindle-inbox extension sees the binding at load time. Like
  // memory, inbox uses the symbol-on-globalThis binding pattern; the
  // engine + agent id must be set before pi's extension loader runs.
  let inboxEngine: InboxEngine | null = null;
  let inboxProjector: InboxProjector | null = null;
  const resolvedInbox = resolveInboxConfig(config, agentDir);
  if (resolvedInbox) {
    if (!memoryEngine) {
      console.warn(
        "[spindle] inbox.enabled=true but memory is disabled — inbox requires the shared DB handle; skipping."
      );
    } else {
      try {
        inboxEngine = await InboxEngine.open({
          memory: memoryEngine,
          config: resolvedInbox,
        });
        bindInboxEngine(inboxEngine);
        bindInboxAgentId(config.agent.id);
        console.log(
          `[spindle] Inbox engine opened — mail_root=${resolvedInbox.mailRoot}`
        );
      } catch (err) {
        console.error(
          `[spindle] Failed to open inbox engine: ${err instanceof Error ? err.message : String(err)}`
        );
        console.error("[spindle] Continuing without inbox");
        inboxEngine = null;
        bindInboxEngine(null);
        bindInboxAgentId(null);
      }
    }
  }

  // Construct every configured channel BEFORE createSpindleSession. pi's
  // extension loader runs synchronously inside createAgentSession, and a
  // channel's extension reads the channel's binding at register time to
  // decide which tools to register. Nothing is started yet — start()
  // needs the session, which is created just below.
  const channels: Channel[] = [];
  let sessionDeps: SharedSessionDeps | null = null;
  const channelHost: ChannelHost = {
    agentDir,
    config,
    channels: () => channels,
    sessionDeps: () => {
      if (!sessionDeps) throw new Error("[spindle] sessionDeps() called before the pi session exists");
      return sessionDeps;
    },
  };
  registerKnownToolNames(config.spindle?.masked_tool_names ?? []);
  publishApi(spindleApi);
  const plugins = await loadPlugins(agentDir, config.plugins ?? [], spindleApi);
  const channelPlugins = [...BUILTIN_CHANNEL_PLUGINS, ...plugins.flatMap((p) => p.channels ?? [])];
  assertUniqueKeys(channelPlugins);
  for (const key of unclaimedChannelKeys(channelPlugins, config)) {
    // Not fatal, like a rejected Telegram token: the agent's other
    // channels and its scheduler are worth keeping up. But unmissable.
    const bar = "[spindle] ============================================================";
    console.error(bar);
    console.error(`[spindle] channels.${key} IS CONFIGURED BUT NOTHING PROVIDES IT.`);
    console.error(`[spindle] This agent is running WITHOUT its "${key}" channel. If it comes`);
    console.error("[spindle] from a plugin, name the plugin's module under `plugins:` in");
    console.error("[spindle] agent.yaml (see docs/plugins.md).");
    console.error(bar);
  }
  const { created: createdChannels, extensionPaths: channelExtensionPaths } =
    await createChannels(channelPlugins, channelHost);

  // Create pi session — resume mode comes from CLI flag (highest priority)
  // or agent.yaml `pi.continue_session` / `pi.resume_session`.
  console.log("[spindle] Creating pi session...");
  const spindleSession = await createSpindleSession(config, agentDir, {
    resumeOverride,
    channelExtensionPaths,
  });
  const { session, getSlashCommands, dependencies } = spindleSession;
  sessionDeps = dependencies;
  // Lets a tool end the run after its turn without aborting a request
  // (a channel's wait tool). See agent/stop-after-turn.ts.
  installStopAfterTurn(session.agent);

  // Turn provenance. Subscribed BEFORE any channel so its
  // listener runs first and channels can query the current run from
  // inside their own event handlers. The spindle-provenance extension
  // (already loaded by pi above) finds it through the binding.
  const provenance = new ProvenanceTracker(session);
  bindProvenanceTracker(provenance);
  // What this agent delivered (images, audio, voice), for a session viewer.
  bindMediaLog(new MediaLog(join(agentDir, ".pi", "media-log.jsonl")));
  // Every delivery to the operator, whichever session sent it.
  bindOutboundLog(new OutboundLog(join(agentDir, ".pi", "outbound-log.jsonl")));

  // Track turns. In REPL mode (interactive), print full assistant text
  // to stdout. In headless mode (service), only log errors and tool
  // activity — the session JSONL is the canonical record of chat, and
  // the journal should stay readable for operational monitoring.
  const headless = config.spindle?.repl === false;
  // Declared before the tracker so the callback can feed it, constructed
  // after channels exist so it can report their liveness.
  let agentStateWriter: AgentStateWriter | null = null;
  const { unsubscribe } = createTurnTracker(session, (turn) => {
    // A turn the agent ended on purpose (a wait tool) is not an LLM error.
    if (consumePlannedAbort(turn.error)) turn = { ...turn, error: undefined };
    agentStateWriter?.recordTurn(turn);
    if (turn.error) {
      console.error(`[spindle] LLM error: ${turn.error}`);
    } else if (!headless && turn.text) {
      console.log(`\n${turn.text}\n`);
    } else if (headless && turn.toolCalls.length > 0) {
      console.log(`[spindle] turn: ${turn.toolCalls.length} tool call(s): ${turn.toolCalls.join(", ")}`);
    }
  });

  // Attach the context telemetry recorder BEFORE any channel starts
  // processing inbound messages, so the very first user turn's
  // latency + tokens + context% show up in context_stats.
  //
  // Telemetry no longer requires memory. It used to read
  // the DB handle off the MemoryEngine, so `memory.enabled: false`
  // silently disabled telemetry too — and agents on a game channel run
  // without memory precisely because they are cheap and numerous, which
  // made them exactly the agents we could not measure. When memory is
  // off, we open the same shared DB directly.
  //
  // Default is unchanged: on when memory is on. Setting
  // spindle.telemetry.enabled: true now genuinely enables it standalone
  // instead of logging a warning and skipping.
  let telemetryRecorder: ContextTelemetryRecorder | null = null;
  let telemetryOwnDb: import("bun:sqlite").Database | null = null;
  const telemetryEnabled =
    config.spindle?.telemetry?.enabled ?? Boolean(memoryEngine);
  if (telemetryEnabled) {
    try {
      let telemetryDb: import("bun:sqlite").Database;
      if (memoryEngine) {
        telemetryDb = memoryEngine.getDb();
      } else {
        const opened = openTelemetryDb(config.memory, process.env, agentDir);
        telemetryOwnDb = opened.db;
        telemetryDb = opened.db;
        console.log(`[spindle] Telemetry DB (standalone): ${opened.path}`);
      }
      telemetryRecorder = new ContextTelemetryRecorder({
        session,
        db: telemetryDb,
        agentId: config.agent.id,
      });
      telemetryRecorder.start();
      // Publish so externally-triggered compactions (Telegram /compact,
      // PR 2 nudge, PR 3 daydream cadence) can bracket their runs via
      // recordExternalCompactStart/End — pi's session.compact() call
      // does not emit auto_compaction_start/end, so without this the
      // compactions go unrecorded.
      bindTelemetryRecorder(telemetryRecorder);
      console.log("[spindle] Context telemetry recorder started");
    } catch (err) {
      console.error(
        `[spindle] Failed to start telemetry recorder: ${err instanceof Error ? err.message : String(err)}`
      );
      telemetryRecorder = null;
      // Only close a handle we opened ourselves; the MemoryEngine owns its own.
      try {
        telemetryOwnDb?.close();
      } catch {
        /* already closed */
      }
      telemetryOwnDb = null;
    }
  }

  // Start the compact nudge runner AFTER the telemetry recorder (so it can
  // bracket its compactions into compact_events) and BEFORE channels start
  // processing inbound messages (so the first over-threshold turn triggers
  // a nudge). Requires spindle.compact.enabled: true — disabled by default
  // so existing agents are unaffected.
  let compactNudgeRunner: CompactNudgeRunner | null = null;
  const compactConfig = config.spindle?.compact;
  if (compactConfig?.enabled) {
    // context_limit is canonical; max_tokens is a deprecated alias.
    // Logs a one-time warning when the alias is used.
    const contextLimit = resolveContextLimit(compactConfig);
    compactNudgeRunner = new CompactNudgeRunner({
      session,
      agentId: config.agent.id,
      thresholdPercent: compactConfig.threshold_percent ?? 70,
      contextLimit,
      instructions: compactConfig.instructions,
      failureCooldownMs: compactConfig.failure_cooldown_seconds !== undefined
        ? compactConfig.failure_cooldown_seconds * 1000
        : undefined,
      verbose: compactConfig.verbose,
    });
    compactNudgeRunner.start();
    // Optional: disable or re-enable pi's native auto-compact at boot.
    if (compactConfig.auto_toggle_pi_native !== undefined) {
      compactNudgeRunner.setAutoCompactionEnabled(compactConfig.auto_toggle_pi_native);
      console.log(
        `[compact] pi native auto-compaction set to ${compactConfig.auto_toggle_pi_native}`
      );
    }
    const contextLimitSuffix =
      contextLimit !== undefined ? `, context_limit ${contextLimit}` : "";
    const verboseSuffix = compactConfig.verbose ? " (verbose)" : "";
    console.log(
      `[compact] nudge runner started — threshold ${compactConfig.threshold_percent ?? 70}%${contextLimitSuffix}${verboseSuffix}`
    );
  }

  // Operator compaction: `systemctl --user kill -s SIGUSR2 <unit>` runs the
  // agent's own session.compact(), so extension hooks (character
  // compaction) and the session's model apply. The external
  // compact-agent.sh rewrites the session file instead; that stays the
  // break-glass path for a larger-context model.
  let signalCompactRunning = false;
  process.on("SIGUSR2", () => {
    if (signalCompactRunning || session.isCompacting) {
      console.log("[compact] SIGUSR2 ignored: a compaction is already running");
      return;
    }
    signalCompactRunning = true;
    const instructions = compactConfig?.instructions;
    const eventId = telemetryRecorder?.recordExternalCompactStart("user_manual", {
      reason: "SIGUSR2",
      instructionsSource: instructions ? "static" : "none",
    });
    console.log("[compact] SIGUSR2: compacting");
    // compact() aborts the turn in flight; that abort is not an LLM error.
    if (session.isStreaming) markPlannedAbort("signal compact");
    void session
      .compact(instructions)
      .then((result) => {
        let tokensAfter: number | null = null;
        try {
          tokensAfter = session.getContextUsage()?.tokens ?? null;
        } catch {
          // best-effort, as in the telegram /compact command
        }
        if (telemetryRecorder && typeof eventId === "number") {
          telemetryRecorder.recordExternalCompactEnd(eventId, { tokensBefore: result.tokensBefore ?? null, tokensAfter });
        }
        console.log(`[compact] SIGUSR2: ${result.tokensBefore} → ${tokensAfter ?? "?"} tokens`);
      })
      .catch((err) => {
        if (telemetryRecorder && typeof eventId === "number") {
          telemetryRecorder.recordExternalCompactEnd(eventId, { error: String(err?.message ?? err) });
        }
        console.error(`[compact] SIGUSR2 compaction failed: ${err?.message ?? err}`);
      })
      .finally(() => {
        signalCompactRunning = false;
      });
  });

  // Now that the session exists, start the pre-constructed channels, in
  // plugin order. A channel that fails to start is logged and left out;
  // the rest of the agent keeps running.
  for (const c of createdChannels) {
    const logName = channelLogName(c);
    try {
      await c.channel.start(session, config, getSlashCommands);
      channels.push(c.channel);
      console.log(`[spindle] ${logName} started`);
    } catch (err) {
      console.error(`[spindle] Failed to start ${logName}:`, err);
      c.plugin.onStartFailure?.(err, c.channel);
    }
  }

  // Per-agent state file. Constructed here, after channels
  // exist, so it can report their liveness. Deliberately has no dependency
  // on memory or telemetry — both are disabled on exactly the agents that
  // need this most, which is how one agent spent hours failing every
  // turn with nothing anywhere exposing it.
  const stateCfg = config.spindle?.state_file;
  if (stateCfg?.enabled) {
    agentStateWriter = new AgentStateWriter({
      session,
      agentId: config.agent.id,
      agentDir,
      channels,
      ...(stateCfg.interval_seconds !== undefined
        ? { intervalMs: stateCfg.interval_seconds * 1000 }
        : {}),
      ...(stateCfg.stale_after_seconds !== undefined
        ? { staleAfterS: stateCfg.stale_after_seconds }
        : {}),
      ...(stateCfg.turn_stale_after_seconds !== undefined
        ? { turnStaleAfterS: stateCfg.turn_stale_after_seconds }
        : {}),
      ...(stateCfg.history_length !== undefined
        ? { historyLength: stateCfg.history_length }
        : {}),
    });
    agentStateWriter.start();
    console.log(
      `[agent-state] writing ${agentDir}/.pi/agent-state.json every ` +
        `${stateCfg.interval_seconds ?? 30}s`,
    );
  }

  // Start the daydream loop if memory is enabled AND daydream is configured.
  // Requires the memory engine (bindings already set above) and uses the
  // main session's file path as the source of session activity to review.
  let daydreamRunner: DaydreamRunner | null = null;
  if (config.memory?.enabled && config.memory.daydream?.enabled && memoryEngine) {
    const sessionFile = (
      session as unknown as {
        sessionManager?: { getSessionFile?: () => string | undefined };
      }
    ).sessionManager?.getSessionFile?.();
    if (!sessionFile) {
      console.warn(
        "[spindle] Daydream skipped: main session has no persistent file (in-memory session?)"
      );
    } else {
      try {
        const factory = createDaydreamSessionFactory(
          dependencies,
          config.memory.daydream
        );
        daydreamRunner = new DaydreamRunner({
          engine: memoryEngine,
          agentId: config.agent.id,
          agentDisplayName: config.agent.name,
          sessionFile,
          config: config.memory.daydream,
          sessionFactory: factory,
          onCycleComplete: (r) => {
            if (r.skipped) {
              console.log(`[daydream] cycle skipped: ${r.skipReason}`);
            } else if (r.errored) {
              console.warn(`[daydream] cycle errored: ${r.errorMessage}`);
            } else {
              console.log(
                `[daydream] cycle stored ${r.stored} memor${r.stored === 1 ? "y" : "ies"} in ${r.durationMs}ms`
              );
            }
          },
        });
        daydreamRunner.start();
        const interval = config.memory.daydream.interval_minutes ?? 30;
        console.log(
          `[daydream] runner started — first cycle in ${interval} minutes`
        );
      } catch (err) {
        console.error("[spindle] Failed to start daydream runner:", err);
      }
    }
  } else if (config.memory?.daydream?.enabled && !config.memory.enabled) {
    console.warn(
      "[spindle] memory.daydream.enabled=true but memory.enabled=false — daydream not started"
    );
  }

  // Start the session ingester BEFORE the web server so /spindle/sessions
  // returns a ready DB from turn one. JSONL is the source of truth; the
  // DB is a queryable projection that every downstream consumer (web
  // API today, agent routes in 4.2, future daydream cutover) reads from.
  // Requires memory enabled — events go into the same SQLite file.
  let ingester: SessionIngester | null = null;
  const piSessionFile = (
    session as unknown as {
      sessionManager?: { getSessionFile?: () => string | undefined };
    }
  ).sessionManager?.getSessionFile?.();
  if (memoryEngine && piSessionFile) {
    const sessionDir = dirname(piSessionFile);
    ingester = new SessionIngester({
      agentId: config.agent.id,
      sessionDir,
      engine: memoryEngine,
    });
    try {
      const added = await ingester.backfill();
      console.log(
        `[spindle] Session ingester backfill complete — ${added} new event(s) from ${sessionDir}`
      );
      ingester.start();
    } catch (err) {
      console.error(
        `[spindle] Session ingester backfill failed: ${err instanceof Error ? err.message : String(err)}`
      );
      ingester = null;
    }
  } else if (!memoryEngine && config.web?.enabled) {
    console.warn(
      "[spindle] web.enabled=true but memory is disabled — /spindle/sessions and /spindle/memories will not serve data"
    );
  }

  // Start the scheduler if a schedule.yaml exists (or an override path is configured).
  // piSessionFile is now resolved — pass it for idle detection.
  // Croner fires at the NEXT cron tick, so there is no race with extension loading.
  let schedulerRunner: SchedulerRunner | null = null;
  {
    const scheduleFile = config.spindle?.scheduler?.schedule_file
      ? resolve(agentDir, config.spindle.scheduler.schedule_file)
      : join(agentDir, ".pi", "schedule.yaml");

    if (existsSync(scheduleFile)) {
      try {
        schedulerRunner = new SchedulerRunner({
          agentDir,
          scheduleFile,
          deps: dependencies,
          piSessionFile: piSessionFile ?? undefined,
        });
        await schedulerRunner.start();
        console.log(`[scheduler] Started — watching ${scheduleFile}`);
      } catch (err) {
        console.error(
          `[spindle] Failed to start scheduler: ${err instanceof Error ? err.message : String(err)}`
        );
        schedulerRunner = null;
      }
    }
  }

  // Run inbox projector backfill + start polling BEFORE the web
  // server so /spindle/inbox serves ready data from turn one. Mirrors
  // the session-ingester boot pattern.
  if (inboxEngine && resolvedInbox) {
    inboxProjector = new InboxProjector({
      engine: inboxEngine,
      pollIntervalMs: resolvedInbox.pollIntervalMs,
    });
    try {
      const result = await inboxProjector.backfill();
      console.log(
        `[spindle] Inbox projector backfill complete — scanned ${result.scanned}, added ${result.added}, skipped ${result.skippedMalformed}`
      );
      inboxProjector.start();
    } catch (err) {
      console.error(
        `[spindle] Inbox projector backfill failed: ${err instanceof Error ? err.message : String(err)}`
      );
      inboxProjector = null;
    }
  }

  // Build and start the Fastify web server if configured. Split into
  // two steps: createWebServer (Fastify instance, no listen yet) then
  // loadSpindleExtensions (so agent routes land before listen()) then
  // listen. Must come after daydream init so /spindle/info can report
  // the daydream flag, and before the REPL so failures here fail fast.
  let webServer: WebServerHandle | null = null;
  let stopExtensions: (() => Promise<void>) | null = null;
  const replEnabled = config.spindle?.repl !== false;
  try {
    const resolvedWeb = resolveWebConfig(config);
    if (resolvedWeb) {
      const webDeps = {
        agentId: config.agent.id,
        agentName: config.agent.name,
        sessionFile: piSessionFile,
        memoryEnabled: Boolean(config.memory?.enabled),
        daydreamEnabled: Boolean(config.memory?.daydream?.enabled),
        replEnabled,
        uiEnabled: resolvedWeb.uiEnabled,
        version: SPINDLE_VERSION,
        engine: memoryEngine,
        inboxEngine,
        inboxEnabled: Boolean(inboxEngine),
        telemetryEnabled: telemetryRecorder !== null,
        getContextUsage: telemetryRecorder
          ? () => {
              try {
                return session.getContextUsage();
              } catch {
                return undefined;
              }
            }
          : undefined,
        getCurrentSessionId: telemetryRecorder
          ? () => {
              try {
                return session.getSessionStats().sessionId;
              } catch {
                return undefined;
              }
            }
          : undefined,
      };

      const app = createWebServer(resolvedWeb, webDeps);

      // Build the SpindleRuntime and load extensions BEFORE listen()
      // so agent routes are registered before the server accepts traffic.
      const runtime = createSpindleRuntime({
        agentId: config.agent.id,
        agentName: config.agent.name,
        agentDir,
        memory: memoryEngine,
        inbox: inboxEngine,
        agentSession: session,
        dispatchWorker: createWorkerDispatcher(dependencies),
        app,
        operatorToken: resolvedWeb.token,
      });

      stopExtensions = await loadSpindleExtensions(
        agentDir,
        config.extensions ?? [],
        runtime
      );

      await app.listen({ host: resolvedWeb.host, port: resolvedWeb.port });
      webServer = {
        app,
        port: resolvedWeb.port,
        host: resolvedWeb.host,
        stop: async () => { await app.close(); },
      };
      console.log(
        `[spindle] Web server listening on http://${webServer.host}:${webServer.port}`
      );
    } else if ((config.extensions ?? []).length > 0) {
      // Extensions declared but web is disabled — load them anyway
      // (spindle extensions are not exclusively web-facing).
      const runtime = createSpindleRuntime({
        agentId: config.agent.id,
        agentName: config.agent.name,
        agentDir,
        memory: memoryEngine,
        inbox: inboxEngine,
        dispatchWorker: createWorkerDispatcher(dependencies),
        // No Fastify app — registerRoute/registerStatic will throw.
        // Provide a stub that fails clearly.
        app: null as never,
        operatorToken: "",
      });
      stopExtensions = await loadSpindleExtensions(
        agentDir,
        config.extensions ?? [],
        runtime
      );
    }
  } catch (err) {
    console.error(
      `[spindle] Failed to start web server: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }

  console.log(`[spindle] Agent "${config.agent.name ?? config.agent.id}" is ready.`);

  // Optional boot notification — sends a direct Telegram message when the
  // agent comes online. Does not require an LLM turn; uses the bot token
  // from the environment directly. Set on_start_prompt in agent.yaml to enable.
  const onStartPrompt = config.spindle?.on_start_prompt;
  if (onStartPrompt) {
    setTimeout(async () => {
      // Find the Telegram channel config for token + allowed users
      const tgConfig = config.channels?.telegram;
      const token = process.env.TELEGRAM_BOT_TOKEN ?? (tgConfig as { bot_token?: string } | undefined)?.bot_token;
      const userId = process.env.TELEGRAM_USER_ID
        ?? process.env.TELEGRAM_ALLOWED_USER_IDS?.split(",")[0]?.trim()
        ?? (tgConfig as { allowed_users?: string[] } | undefined)?.allowed_users?.[0];

      if (token && userId) {
        try {
          const { execFileSync } = await import("child_process");
          execFileSync("curl", ["-s",
            `https://api.telegram.org/bot${token}/sendMessage`,
            "-d", `chat_id=${userId}`,
            "--data-urlencode", `text=${onStartPrompt}`,
          ], { stdio: "pipe" });
          console.log("[spindle] on_start_prompt sent via Telegram");
        } catch (err) {
          console.error("[spindle] on_start_prompt Telegram send failed:", err);
        }
      } else {
        // Fallback: inject as a session prompt (no guaranteed Telegram output)
        provenance
          .dispatch(onStartPrompt, origin("system", { kind: "system", id: "on_start_prompt" }))
          .catch((err) =>
          console.error("[spindle] on_start_prompt session prompt failed:", err)
        );
      }
    }, 3000);
  }

  // Handle graceful shutdown — declared here so both REPL and headless
  // paths can register the SIGINT/SIGTERM handler below.
  let rl: import("readline").Interface | null = null;
  const shutdown = async () => {
    console.log("\n[spindle] Shutting down...");

    // Shutdown steps are awaited sequentially, so any one of them that never
    // settles wedges the whole process until the supervisor SIGKILLs it —
    // which kills ephemeral sessions mid-write and strands whatever they had
    // claimed. This happened repeatedly: Fastify's app.close() waits on the
    // long-lived connection a client holds to the web API, so shutdown sat
    // silent for systemd's full 90s TimeoutStopSec every restart.
    //
    // Two defenses. Each step gets a bounded wait and SAYS which one stalled,
    // so the next occurrence is diagnosable from the journal instead of from
    // a silent gap. And a hard watchdog guarantees the process leaves even if
    // something below is pathological.
    const STEP_TIMEOUT_MS = 8_000;
    const HARD_EXIT_MS = 30_000;

    const hardExit = setTimeout(() => {
      console.error(
        `[spindle] shutdown exceeded ${HARD_EXIT_MS}ms — forcing exit; some teardown did not finish`
      );
      process.exit(1);
    }, HARD_EXIT_MS);
    // Do not let the watchdog itself be the reason the loop stays alive.
    (hardExit as unknown as { unref?: () => void }).unref?.();
    // The timer above cannot fire if the main thread is blocked synchronously
    // or Bun's process.exit never returns — which is how an agent kept hanging
    // for systemd's full 90s with neither the step warning nor the hard exit
    // logging. An out-of-process watchdog covers that: it
    // leaves quietly when we exit, else logs every thread's kernel wait
    // channel and SIGKILLs us. Armed after the hard exit so the in-process
    // path (which names the stuck step) gets the first chance.
    armShutdownWatchdog({ afterMs: HARD_EXIT_MS + 10_000 });

    // Every line below carries elapsed ms since SIGTERM. Those
    // hangs logged nothing after "[obs-ingester] Stopped." — not even
    // the 8s step warning or the 30s hard exit — so the main thread was
    // blocked synchronously, not awaiting. Naming each step as it STARTS, and
    // logging the sync closes and the final exit, puts the next hang between
    // two named lines instead of in a 90s silence.
    const t0 = Date.now();
    const mark = (what: string) => console.log(`[spindle] shutdown +${Date.now() - t0}ms: ${what}`);
    const step = async (name: string, fn: () => Promise<unknown> | unknown): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      mark(`${name}…`);
      try {
        const raced = await Promise.race([
          Promise.resolve(fn()).then(() => "done" as const),
          new Promise<"timeout">((res) => {
            timer = setTimeout(() => res("timeout"), STEP_TIMEOUT_MS);
          }),
        ]);
        if (raced === "timeout") {
          console.warn(
            `[spindle] shutdown step "${name}" did not finish within ${STEP_TIMEOUT_MS}ms — continuing without it`
          );
        }
      } catch (err) {
        console.error(`[spindle] shutdown step "${name}" failed:`, err);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    // Signal extensions immediately so their setInterval callbacks can
    // check signal.aborted before spawning subprocesses.
    shutdownController.abort();
    rl?.close();
    unsubscribe();
    provenance.stop();
    bindProvenanceTracker(null);
    bindMediaLog(null);
    bindOutboundLog(null);
    for (const channel of channels) {
      if (channel.beforeShutdown) {
        await step(`${channel.name} channel (before shutdown)`, () => channel.beforeShutdown!());
      }
    }
    for (const channel of channels) {
      await step(`${channel.name} channel`, () => channel.stop());
    }
    if (stopExtensions) {
      await step("extension teardowns", () => stopExtensions!());
    }
    if (daydreamRunner) {
      await step("daydream runner", () => daydreamRunner!.stop());
    }
    if (schedulerRunner) {
      // Give this one room: it drains in-flight ephemeral sessions on purpose
      // and has its own 10s drain timeout plus force-close.
      await step("scheduler runner", () => schedulerRunner!.stop());
    }
    if (webServer) {
      await step("web server", () => webServer!.stop());
    }
    if (ingester) {
      await step("session ingester", () => ingester!.stop());
    }
    if (inboxProjector) {
      await step("inbox projector", () => inboxProjector!.stop());
    }
    mark("sync teardown (nudge, telemetry, inbox, memory)…");
    if (compactNudgeRunner) {
      try {
        compactNudgeRunner.stop();
      } catch (err) {
        console.error("[spindle] Error stopping compact nudge runner:", err);
      }
    }
    if (telemetryRecorder) {
      try {
        telemetryRecorder.stop();
      } catch (err) {
        console.error("[spindle] Error stopping telemetry recorder:", err);
      }
      bindTelemetryRecorder(null);
    }
    if (inboxEngine) {
      try {
        inboxEngine.close();
      } catch (err) {
        console.error("[spindle] Error closing inbox engine:", err);
      }
      bindInboxEngine(null);
      bindInboxAgentId(null);
    }
    if (memoryEngine) {
      try {
        memoryEngine.close();
      } catch (err) {
        console.error("[spindle] Error closing memory engine:", err);
      }
      bindMemoryEngine(null);
      bindMemoryAgentId(null);
      bindDaydreamActive(false);
      bindMainStoreEnabled(true);
    }
    // Standalone telemetry handle (memory disabled) — the MemoryEngine
    // owns its own handle, so this is only set when we opened one.
    if (telemetryOwnDb) {
      try {
        telemetryOwnDb.close();
      } catch (err) {
        console.error("[spindle] Error closing telemetry DB:", err);
      }
      telemetryOwnDb = null;
    }
    bindShutdownSignal(null);
    clearTimeout(hardExit);
    mark("teardown complete — process.exit(0)");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  if (replEnabled) {
    console.log("[spindle] Type a message to chat. Ctrl+C to quit.\n");
    const readline = await import("readline");
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const promptUser = () => rl!.question("> ", async (input: string) => {
      const trimmed = input.trim();
      if (!trimmed) {
        promptUser();
        return;
      }
      try {
        await provenance.dispatch(trimmed, origin("cli", { kind: "human", id: "operator" }));
        await waitForIdle(session);
      } catch (err) {
        console.error("[spindle] Error:", err);
      }
      promptUser();
    });
    promptUser();
  } else {
    const hasBackground =
      channels.length > 0 ||
      daydreamRunner !== null ||
      schedulerRunner !== null ||
      webServer !== null ||
      ingester !== null ||
      inboxProjector !== null;
    if (hasBackground) {
      console.log(
        "[spindle] REPL disabled. Running headless — Ctrl+C to quit."
      );
    } else {
      console.warn(
        "[spindle] REPL disabled and no channels or daydream running — nothing to do."
      );
      await shutdown();
    }
  }
}

main().catch((err) => {
  console.error("[spindle] Fatal error:", err);
  process.exit(1);
});
