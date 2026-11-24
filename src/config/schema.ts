import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AgentConfig, ValidationResult } from "../types";

const ThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
]);

const UserAccessEntrySchema = Type.Union([
  Type.String(),
  Type.Object({
    id: Type.String(),
    session: Type.Optional(Type.String()),
    access: Type.Optional(
      Type.Union([
        Type.Literal("full"),
        Type.Literal("single"),
        Type.Literal("room"),
      ])
    ),
  }),
]);

export const AgentConfigSchema = Type.Object({
  agent: Type.Object({
    id: Type.String({ minLength: 1 }),
    name: Type.Optional(Type.String()),
  }),
  /**
   * Harness-level spindle config, separate from `pi.*` (which targets
   * pi-agent options) and `channels.*` / `memory.*` (which target
   * specific subsystems). Use this for flags that control the spindle
   * process itself — REPL, logging, etc.
   */
  spindle: Type.Optional(
    Type.Object({
      /**
       * Start the stdin REPL after the agent is ready. Default true
       * to preserve the interactive developer experience. Set to
       * `false` for headless production runs (service units, agents
       * driven purely by channels). When disabled, spindle stays alive
       * only if at least one channel or the daydream runner is active;
       * otherwise it logs a warning and exits cleanly.
       */
      repl: Type.Optional(Type.Boolean()),
      /**
       * Per-turn context telemetry — records latency, token counts,
       * context-window percent, and compaction events to the shared
       * memory DB so we can graph context growth over time. Requires
       * memory.enabled=true (same DB handle). Default true when memory
       * is on. Telemetry is read-only for the agent — it never appears
       * as a tool and has no effect on behavior.
       */
      telemetry: Type.Optional(
        Type.Object({
          enabled: Type.Optional(Type.Boolean()),
        })
      ),
      /**
       * Extra tool names to mask when a model writes a call out as text
       * (util/fake-tool-calls.ts). For tools from extensions that do not
       * register their names themselves.
       */
      masked_tool_names: Type.Optional(Type.Array(Type.String({ pattern: "^\\w+$" }))),
      /**
       * Per-agent state file at `<agentDir>/.pi/agent-state.json`.
       * Written for an EXTERNAL observer — watchdogs,
       * fleet aggregation, escalation — never read back by the agent.
       *
       * Records the two clocks whose divergence detects "alive but unable
       * to think" (heartbeat_at vs last_turn_ok_at), API-reported context
       * usage with enough history to derive rate, and per-channel liveness.
       *
       * Opt-in so rollout is deliberate. No dependency on memory or
       * telemetry — those are disabled on exactly the agents that need
       * this most.
       */
      state_file: Type.Optional(
        Type.Object({
          enabled: Type.Optional(Type.Boolean()),
          /** Write cadence in seconds. Default 30. */
          interval_seconds: Type.Optional(Type.Number()),
          /** Declared in the file; readers treat older as `unknown`. Default 120. */
          stale_after_seconds: Type.Optional(Type.Number()),
          /** Idle agents legitimately complete no turns. Default 3600. */
          turn_stale_after_seconds: Type.Optional(Type.Number()),
          /** Context samples retained for rate derivation. Default 10. */
          history_length: Type.Optional(Type.Number()),
        })
      ),
      /**
       * Threshold-triggered compaction nudge. When context_percent
       * crosses `threshold_percent` after a turn, spindle calls
       * session.compact() proactively before pi's native auto-compact
       * fires at ~91% (with one agent's tuned settings). Disabled by default.
       * Requires memory.enabled=true for telemetry recording, but the
       * nudge itself works without it (compact still fires, just not
       * recorded in compact_events).
       */
      compact: Type.Optional(
        Type.Object({
          /**
           * Enable the nudge runner. Default false — opt in explicitly
           * so existing agents are unaffected.
           */
          enabled: Type.Optional(Type.Boolean()),
          /**
           * Context-window fill percent (0–100) that triggers a nudge.
           * Default 70. At one agent's tuned settings (contextWindow=118000,
           * reserveTokens=10240) pi-auto fires at 91.3%, so 70% gives
           * ~21 points of buffer and a compact input of only ~44K tokens
           * vs ~68K at pi-auto time.
           */
          threshold_percent: Type.Optional(
            Type.Number({ minimum: 0, maximum: 100 })
          ),
          /**
           * Absolute CONTEXT cap — fires when getContextUsage().tokens
           * >= context_limit, independent of threshold_percent. Use this as a
           * belt-and-suspenders trigger when a provider reports a very large
           * contextWindow that doesn't match practical operating size
           * (e.g. github-copilot claude-sonnet-4.6 reports 1M tokens, but
           * cost/latency suggest compacting much earlier). Whichever
           * threshold crosses first fires the nudge.
           *
           * Unrelated to a model's `maxTokens` in ~/.pi/agent/models.json,
           * which is the RESPONSE budget.
           */
          context_limit: Type.Optional(Type.Number({ minimum: 1 })),
          /**
           * Deprecated alias for `context_limit`. Still honored; if both are
           * set, context_limit wins. Logs a one-time warning at boot.
           */
          max_tokens: Type.Optional(Type.Number({ minimum: 1 })),
          /**
           * Per-turn diagnostic log line on every agent_end, describing
           * what the runner saw and why it did/didn't fire. Use when
           * investigating "should have fired but didn't" bugs. Default
           * false — this logs every turn so leave it off in steady state.
           */
          verbose: Type.Optional(Type.Boolean()),
          /**
           * Static focus instructions forwarded to session.compact().
           * Capped at 500 chars internally. When absent, compact() runs
           * with no custom instructions (uses pi's built-in defaults).
           */
          instructions: Type.Optional(Type.String({ maxLength: 2000 })),
          /**
           * Seconds to wait before retrying after a failed compact.
           * Default 300 (5 min). Prevents a crash-loop if the model
           * consistently fails compaction (e.g. vLLM overload).
           */
          failure_cooldown_seconds: Type.Optional(
            Type.Number({ minimum: 0 })
          ),
          /**
           * When set, calls session.setAutoCompactionEnabled(value) once
           * at boot. Use `false` to disable pi's native auto-compact when
           * the nudge runner takes over, or leave unset to let both run
           * (nudge fires first at the lower threshold; pi-auto is a
           * safety net if the nudge fails).
           */
          auto_toggle_pi_native: Type.Optional(Type.Boolean()),
        })
      ),
      /**
       * Cron-based scheduler that fires registered slash commands as
       * ephemeral pi sessions. Reads `.pi/schedule.yaml` by default.
       * Hot-reloads when the file changes — no service restart needed.
       */
      scheduler: Type.Optional(
        Type.Object({
          /**
           * Path to the schedule file. Absolute or agent-dir-relative.
           * Default `.pi/schedule.yaml`.
           */
          schedule_file: Type.Optional(Type.String()),
        })
      ),
      /**
       * Optional prompt sent to the agent immediately after boot.
       * Useful for agents that need a turn to become "present" after
       * restart (e.g. checking inbox, recalling context). Omit or set
       * to empty string to disable.
       */
      on_start_prompt: Type.Optional(Type.String()),
    })
  ),
  pi: Type.Optional(
    Type.Object({
      provider: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      thinking_level: Type.Optional(ThinkingLevelSchema),
      system_prompt: Type.Optional(Type.String()),
      tools: Type.Optional(Type.Array(Type.String())),
      extensions: Type.Optional(Type.Boolean()),
      skills: Type.Optional(Type.Boolean()),
      load_extensions: Type.Optional(Type.Array(Type.String())),
      // Controls which AGENTS.md / CLAUDE.md files pi loads as project
      // context. Default (omitted) is "agent_dir_only" — loads only the
      // AGENTS.md/CLAUDE.md from the agent directory itself, no ancestor
      // walking. "auto" restores pi's native behavior: walk ancestors
      // from cwd up to /, picking the first of [AGENTS.md, CLAUDE.md]
      // per directory. "none" disables context-file loading entirely.
      // An array is an explicit list of paths resolved relative to the
      // agent directory.
      context_files: Type.Optional(
        Type.Union([
          Type.Literal("auto"),
          Type.Literal("agent_dir_only"),
          Type.Literal("none"),
          Type.Array(Type.String()),
        ])
      ),
      session_dir: Type.Optional(Type.String()),
      // Boot-time session resume. continue_session=true loads the most
      // recent session on startup (chassy's -c workflow). resume_session
      // loads a specific session file (chassy's --resume). If both are
      // set, resume_session wins. CLI flags override either.
      main_session: Type.Optional(Type.Boolean()),

      continue_session: Type.Optional(Type.Boolean()),
      resume_session: Type.Optional(Type.String()),
    })
  ),
  channels: Type.Optional(
    Type.Object({
      telegram: Type.Optional(
        Type.Object({
          bot_token: Type.String(),
          allowed_users: Type.Optional(Type.Array(UserAccessEntrySchema)),
          /**
           * Register outbound telegram_send_message / telegram_send_image
           * pi tools via the spindle-telegram extension. Default true.
           * Set to false for receive-only agents.
           */
          outbound_tools: Type.Optional(Type.Boolean()),
          /**
           * When true, inbound images are attached to the user message as
           * native multimodal content (pi ImageContent) so a VL-capable
           * model sees the pixels directly — no `read`/view tool call
           * needed. The text sentinel `[User sent an image: files/...]`
           * is still included for backward compatibility (indexing
           * extensions key on it). Default false: sentinel-only, the
           * model must call `read` to load the file. Enable only for
           * vision-capable models.
           */
          native_images: Type.Optional(Type.Boolean()),
          /**
           * Tool names whose successful results are auto-forwarded to
           * Telegram as images. Default: ["imagine", "image_edit",
           * "image_combine"] — matches a typical image extension's contract.
           */
          auto_send_tools: Type.Optional(Type.Array(Type.String())),
          /**
           * Files directory for received images + relative outbound
           * sendImage paths. Absolute or agent-relative. Default
           * `<agent-dir>/files`.
           */
          files_directory: Type.Optional(Type.String()),
        })
      ),
      /** Hand-driven test channels; see src/channels/stub/channel.ts. */
      stub: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String({ minLength: 1, pattern: "^[a-z0-9_-]+$" }),
            socket: Type.Optional(Type.String()),
            log: Type.Optional(Type.String()),
          })
        )
      ),
    })
  ),
  /**
   * Phase 4 Web API. Promoted out of `channels.*` because the web
   * surface is not a per-session chat transport — it enumerates and
   * addresses sessions and is a first-class spindle subsystem, not a
   * Channel.
   */
  web: Type.Optional(
    Type.Object({
      /**
       * Boot the Fastify server alongside the stdin REPL. Default false
       * — agents without a `web:` block boot exactly as they do today.
       */
      enabled: Type.Optional(Type.Boolean()),
      /** Interface to bind on. Default `127.0.0.1` (loopback only). */
      bind_host: Type.Optional(Type.String()),
      /** TCP port. Required when `enabled: true`. */
      port: Type.Optional(Type.Number({ minimum: 1, maximum: 65535 })),
      /**
       * Name of the env var holding the operator bearer token. Default
       * `SPINDLE_WEB_TOKEN`. Startup fails fast if the env var is
       * unset/empty while web is enabled — no silent no-auth fallback.
       */
      token_env: Type.Optional(Type.String()),
      /**
       * Serve the built-in browse/curate UI from `src/web/public/`.
       * Default true when web is enabled. Set to false for API-only
       * headless operation — JSON routes are unaffected either way.
       */
      ui_enabled: Type.Optional(Type.Boolean()),
    })
  ),
  /**
   * Phase 4.3 spindle extensions. Loaded at boot by spindle (not by pi's
   * resource loader). Each entry names a module relative to the agent
   * directory that exports register(runtime: SpindleRuntime). Not
   * restricted to web — can be used for file maintenance, indexing, etc.
   */
  extensions: Type.Optional(
    Type.Array(
      Type.Object({
        module: Type.String({
          minLength: 1,
          description:
            "Path to the spindle extension module, relative to the agent directory.",
        }),
      }),
      { description: "Spindle extensions loaded at boot. Each must export register(runtime)." }
    )
  ),
  /**
   * Plugins: modules from outside spindle that add channels. Loaded
   * before the pi session is built; a channel named here is turned on
   * by its own key under `channels:`. See src/plugins/loader.ts.
   */
  plugins: Type.Optional(
    Type.Array(
      Type.Object({
        module: Type.String({
          minLength: 1,
          description:
            "Plugin module: a path relative to the agent directory (./ or ../), an absolute path, or a package specifier.",
        }),
      }),
    ),
  ),
  /**
   * Phase 4.4 inbox / outbox / contacts. Addressed-delivery messages
   * live as markdown files under `mail_root`; SQLite is a per-spindle
   * derived projection. Enabled opt-in — agents without this block
   * boot as before.
   */
  inbox: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean()),
      /**
       * Absolute, `~/`-expandable, or agent-dir-relative path to this
       * spindle's mail root. Default `{agent-dir}/.pi/mail`.
       */
      mail_root: Type.Optional(Type.String()),
      /**
       * How often the projector picks up filesystem changes. Default 30s.
       */
      poll_interval_seconds: Type.Optional(
        Type.Number({ minimum: 1 })
      ),
      /**
       * Where unroutable-send falls through AND where the operator
       * composes from. Default `$XDG_DATA_HOME/spindle/operator/mail`
       * with standard fallbacks. Shared across spindles on the host.
       */
      operator_mail_root: Type.Optional(Type.String()),
      /**
       * Agent-display-name override for this spindle's own `self` route.
       * Defaults to agent.name or agent.id.
       */
      agent_display_name: Type.Optional(Type.String()),
      /**
       * Seeded routing table entries — `self` and `operator` are
       * auto-added; use this for peers (alice, bob, etc.).
       */
      contacts: Type.Optional(
        Type.Array(
          Type.Object({
            agent_id: Type.String({ minLength: 1 }),
            mail_root: Type.String({ minLength: 1 }),
            display_name: Type.Optional(Type.String()),
            avatar_path: Type.Optional(Type.String()),
            capabilities: Type.Optional(Type.Array(Type.String())),
          })
        )
      ),
    })
  ),
  memory: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean()),
      /**
       * Absolute path or ~-prefixed path to the memory DB file. When
       * absent, the engine resolves via:
       *   1. $SPINDLE_MEMORY_DB
       *   2. $XDG_DATA_HOME/spindle/memory.db
       *   3. $HOME/.local/share/spindle/memory.db
       */
      database_path: Type.Optional(Type.String()),
      /**
       * Whether the main user-facing session should have the
       * spindle_memory_store tool registered. Daydream ephemeral
       * sessions always get it regardless of this flag.
       *
       * Default behavior (when unset):
       *   - daydream.enabled=false → `true` (Phase 2 backwards compat)
       *   - daydream.enabled=true  → `false` (daydream is sole writer)
       *
       * Explicit values override the default. Use cases:
       *   - `false` with no daydream: read-only agent that can
       *     `spindle_memory_recall` but never write
       *   - `true` with daydream on: both paths write; daydream
       *     dedupes on subsequent cycles
       */
      main_session_store_tool: Type.Optional(Type.Boolean()),
      /**
       * Optional embedding provider. When present, the engine computes
       * and stores vector embeddings for every memory and uses cosine
       * similarity in recall scoring. When absent, the engine runs
       * FTS5-only — still useful, just less semantically fuzzy.
       */
      embedding: Type.Optional(
        Type.Object({
          /** Provider label — informational, not dispatched on. */
          provider: Type.String(),
          /** Model id the provider recognizes (e.g. text-embedding-3-small). */
          model: Type.String(),
          /** Base URL of an OpenAI-compatible endpoint. */
          base_url: Type.Optional(Type.String()),
          /** Env var to read the API key from (optional for local providers). */
          api_key_env: Type.Optional(Type.String()),
          /** Expected dimensions — informational. */
          dimensions: Type.Optional(Type.Integer({ minimum: 1 })),
        })
      ),
      /**
       * Phase 2.1 scoring configuration. `mode: "linear"` (default)
       * keeps the existing weighted-sum scoring; `"act-r"` switches to
       * ACT-R power-law activation over the full access history.
       * Writes to `memory_accesses` happen in both modes so switching
       * requires no backfill.
       */
      scoring: Type.Optional(
        Type.Object({
          mode: Type.Optional(
            Type.Union([Type.Literal("linear"), Type.Literal("act-r")])
          ),
          /**
           * Optional overrides for individual ScoreWeights fields. All
           * fields are optional and fall back to DEFAULT_WEIGHTS; the
           * engine spreads them in so agents only have to specify what
           * they want to tune.
           */
          weights: Type.Optional(
            Type.Object({
              fts: Type.Optional(Type.Number()),
              recency: Type.Optional(Type.Number()),
              frequency: Type.Optional(Type.Number()),
              similarity: Type.Optional(Type.Number()),
              link_boost: Type.Optional(Type.Number()),
              decay_ms: Type.Optional(Type.Number({ minimum: 1 })),
              saturation: Type.Optional(Type.Number({ minimum: 1 })),
              link_half_life_ms: Type.Optional(Type.Number({ minimum: 1 })),
              act_r_d: Type.Optional(Type.Number({ minimum: 0 })),
              act_r_scale_ms: Type.Optional(Type.Number({ minimum: 1 })),
            })
          ),
        })
      ),
      /**
       * Phase 2.1 association-based recall expansion. After the direct
       * FTS phase, walk outbound links from the top seeds and rescore
       * neighbors so well-connected memories surface even when the
       * query doesn't lexically match them. Default enabled.
       */
      association: Type.Optional(
        Type.Object({
          enabled: Type.Optional(Type.Boolean()),
          /** Top-N direct matches used as association seeds. Default 5. */
          seed_count: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
          /** Top-M links expanded per seed. Default 3. */
          per_seed: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
        })
      ),
      /**
       * Spindle memory daydream — background loop that reviews recent
       * session activity and stores memories without requiring the
       * agent to call spindle_memory_store explicitly. See
       * src/daydream/ for the implementation.
       *
       * Disabled by default. Requires `memory.enabled: true`.
       */
      daydream: Type.Optional(
        Type.Object({
          enabled: Type.Optional(Type.Boolean()),
          /** Cycle period in minutes. Default 30. */
          interval_minutes: Type.Optional(Type.Number({ minimum: 1 })),
          /** Window of session activity to review each cycle. Default 60 minutes. */
          lookback_minutes: Type.Optional(Type.Number({ minimum: 1 })),
          /** Skip cycle if fewer new conversational turns since last run. Default 2. */
          min_turns_since_last: Type.Optional(Type.Integer({ minimum: 0 })),
          /** Cap on memories stored per cycle. Default 5. */
          max_store_per_cycle: Type.Optional(Type.Integer({ minimum: 1 })),
          /**
           * Optional model override for ephemeral daydream sessions.
           * When omitted, daydream uses the same model as the main
           * agent (inherited from pi.provider / pi.model).
           */
          model: Type.Optional(
            Type.Object({
              provider: Type.String(),
              model: Type.String(),
              thinking_level: Type.Optional(ThinkingLevelSchema),
            })
          ),
        })
      ),
    })
  ),
});

export type AgentConfigSchemaType = Static<typeof AgentConfigSchema>;

export function validateConfig(data: unknown): ValidationResult<AgentConfig> {
  const errors = [...Value.Errors(AgentConfigSchema, data)];
  if (errors.length === 0) {
    return { success: true, data: data as AgentConfig };
  }
  return {
    success: false,
    errors: errors.map((e) => `${e.path}: ${e.message}`),
  };
}
