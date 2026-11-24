export type ValidationResult<T> = {
  success: true;
  data: T;
} | {
  success: false;
  errors: string[];
};

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface AgentConfig {
  agent: {
    id: string;
    name?: string;
  };
  spindle?: {
    /**
     * Start the stdin REPL after boot. Default true. Set to false for
     * headless production runs driven by channels only — spindle stays
     * alive via the channel / daydream event loop instead.
     */
    repl?: boolean;
    /**
     * Per-turn context telemetry. When enabled and memory is on,
     * spindle records `context_stats` and `compact_events` rows to
     * the shared memory DB and exposes `/spindle/context/*` routes.
     * Default true when memory is enabled.
     */
    telemetry?: {
      enabled?: boolean;
    };
    /**
     * Phase 5.2 threshold-triggered compaction nudge. Disabled by
     * default. When enabled, spindle calls session.compact() after any
     * turn where context_percent >= threshold_percent (default 70).
     */
    compact?: {
      enabled?: boolean;
      threshold_percent?: number;
      /**
       * Absolute CONTEXT cap in tokens. Fires when context tokens >=
       * context_limit, independent of threshold_percent. Use when a
       * provider reports a very large contextWindow that doesn't match
       * practical operating size. Either threshold crosses → nudge fires.
       * Not the model's `maxTokens` in models.json (that is the response
       * budget). Resolve via `resolveContextLimit()` in src/compact/config.ts.
       */
      context_limit?: number;
      /** @deprecated alias for `context_limit`. */
      max_tokens?: number;
      /** Per-turn diagnostic log line on every agent_end. Default false. */
      verbose?: boolean;
      instructions?: string;
      failure_cooldown_seconds?: number;
      auto_toggle_pi_native?: boolean;
    };
    /**
     * Extra tool names to mask when a model writes a call out as text
     * instead of calling the tool. Extensions can register their own; this
     * is for the ones that do not.
     */
    masked_tool_names?: string[];
    /**
     * Per-agent state file at `<agentDir>/.pi/agent-state.json`.
     * Written for an EXTERNAL observer — watchdogs, fleet
     * aggregation, escalation — and never read back by the agent.
     *
     * Records the two clocks whose divergence detects "alive but unable to
     * think" (heartbeat_at vs last_turn_ok_at), API-reported context usage
     * with enough history to derive rate rather than level, and per-channel
     * liveness. Opt-in; no dependency on memory or telemetry, which are
     * disabled on exactly the agents that need this most.
     */
    state_file?: {
      enabled?: boolean;
      interval_seconds?: number;
      stale_after_seconds?: number;
      turn_stale_after_seconds?: number;
      history_length?: number;
    };
    scheduler?: {
      schedule_file?: string;
    };
    /**
     * Optional prompt sent to the agent immediately after boot. Omit or
     * set to empty string to disable.
     */
    on_start_prompt?: string;
  };
  pi?: {
    provider?: string;
    model?: string;
    thinking_level?: ThinkingLevel;
    system_prompt?: string;
    tools?: string[];                  // e.g. ["read"] or ["read", "bash", "edit", "write"]
    extensions?: boolean;              // false = --no-extensions (disable auto-discovery)
    skills?: boolean;                  // false = --no-skills (disable global skills)
    load_extensions?: string[];        // explicit extension paths (relative to agent dir)
    context_files?: "auto" | "agent_dir_only" | "none" | string[]; // AGENTS.md/CLAUDE.md loading mode
    session_dir?: string;              // session storage dir (relative to agent dir)
    main_session?: boolean;           // pin to a designated "main" session via sidecar marker
    continue_session?: boolean;        // load most recent session on boot (chassy -c)
    resume_session?: string;           // load a specific session file on boot (chassy --resume)
  };
  /**
   * Phase 4.3 spindle extensions. Loaded at boot by spindle (not by pi's
   * resource loader). Each entry names a module relative to the agent
   * directory that exports register(runtime: SpindleRuntime).
   */
  extensions?: Array<{ module: string }>;
  /**
   * Plugins: modules from outside spindle that add channels. Loaded
   * before the pi session is built. See src/plugins/loader.ts.
   */
  plugins?: Array<{ module: string }>;
  channels?: {
    telegram?: {
      bot_token: string;
      allowed_users?: Array<
        | string
        | {
            id: string;
            session?: string;
            access?: "full" | "single" | "room";
          }
      >;
      /**
       * Register outbound telegram_send_message / telegram_send_image
       * pi tools via the spindle-telegram extension. Default true.
       * Set to false for receive-only agents.
       */
      outbound_tools?: boolean;
      /**
       * When true, inbound images are attached to the user message as
       * native multimodal content (pi ImageContent) so a VL-capable model
       * sees the pixels directly — no `read`/view tool call needed. The
       * text sentinel is still included for backward compatibility.
       * Default false. Enable only for vision-capable models.
       */
      native_images?: boolean;
      /**
       * Tool names whose successful results are auto-forwarded to
       * Telegram as images (e.g. an image extension's "imagine"). The
       * result object must expose a `filename` in its details.
       * Default: ["imagine", "image_edit", "image_combine"].
       */
      auto_send_tools?: string[];
      /**
       * Absolute or agent-relative path to the files directory where
       * received images land and from which sendImage resolves relative
       * paths. Default: `<agent-dir>/files`.
       */
      files_directory?: string;
    };
    /**
     * Hand-driven test channels (see src/channels/stub/channel.ts). Each
     * entry is one independent "door" on a Unix socket, used to prove
     * multi-channel provenance and routing without real transports.
     * Not for production agents.
     */
    stub?: Array<{
      name: string;
      /** Socket path, absolute or agent-relative. Default `<name>.sock`. */
      socket?: string;
      /** Log file, absolute or agent-relative. Default `<name>.log`. */
      log?: string;
    }>;
    /**
     * Channels from plugins (agent.yaml `plugins:`). Spindle does not
     * know their shape; each plugin reads and checks its own key.
     */
    [key: string]: unknown;
  };
  /**
   * Phase 4 Web API. Top-level rather than under `channels.*` because
   * the web surface enumerates and addresses sessions; it's not a
   * per-session chat transport.
   */
  web?: {
    enabled?: boolean;
    bind_host?: string;
    port?: number;
    token_env?: string;
    ui_enabled?: boolean;
  };
  /**
   * Phase 4.4 inbox subsystem. Opt-in per-agent. Defaults:
   *   mail_root: {agent-dir}/.pi/mail
   *   operator_mail_root: XDG-resolved ~/.local/share/spindle/operator/mail
   *   poll_interval_seconds: 30
   */
  /**
   * Text-to-speech, so the agent can answer in its own voice rather than
   * only in text. Registers a single `speak` tool via the auto-injected
   * `spindle-speak` extension.
   *
   * Backed by an audio.cpp server (`audiocpp_server`), which exposes an
   * OpenAI-shaped POST /v1/audio/speech and treats named voices as
   * first-class config. Several agents can therefore share ONE endpoint
   * and differ only by `voice`.
   *
   * Telegram renders a voice note only for OGG/Opus, so the extension
   * transcodes with ffmpeg before handing the file off; without ffmpeg on
   * PATH the tool refuses to register.
   */
  speech?: {
    enabled?: boolean;
    /** Base URL of the audio.cpp server. Default http://127.0.0.1:8091 */
    endpoint?: string;
    /** Server-side model id (audiocpp `models[].id`). Default "voices". */
    model?: string;
    /**
     * Opt-in streaming model id (an audiocpp entry with mode:streaming,
     * e.g. "voice-stream"). When set, a `speak` in a run opened from a channel
     * that can play live audio is streamed: heard there from its first audio
     * (~2s) and written to the same OGG/Opus file at the end. Other runs keep
     * the one-shot `model` path. Benchmarked: warm first audio ~1.4–2.1s.
     */
    stream_model?: string;
    /** audio.cpp stream_frames_per_event. Benchmark winner: 24. */
    stream_frames_per_event?: number;
    /** audio.cpp stream_lookahead_margin. Default 12. */
    stream_lookahead_margin?: number;
    /**
     * Named voice preset on that model — this is the agent's identity.
     * Omit to accept the server's `default_voice_preset`, which is only
     * sensible when a single agent uses the endpoint.
     */
    voice?: string;
    /**
     * Where generated speech is written. Must resolve inside the Telegram
     * files directory for auto-send to be able to deliver it.
     * Default: `<files_directory>/speech`.
     */
    output_directory?: string;
    /** Hard cap on characters per utterance. Default 1200. */
    max_characters?: number;
    /**
     * What to caption each voice note with when the tool call does not
     * supply one. "transcript" (default) uses the spoken words, so the
     * note can be read and searched in Telegram without playing it —
     * Telegram's own transcribe button exists because voice notes are
     * otherwise opaque, and we already know what was said. "none" sends
     * it bare. Captions are truncated to Telegram's 1024-char limit.
     */
    caption_mode?: "transcript" | "none";
    /** Request timeout in ms. Default 180000. */
    timeout_ms?: number;
    /**
     * How this agent sounds, written in its own voice and appended to the
     * `speak` tool description — so it is in context at the moment it
     * decides to speak, not sitting in a memory file it has to go fetch.
     *
     * A `speak` tool with no self-knowledge behind it produces narration
     * rather than speech, and an agent that does not know it can sound
     * tired will never ask to. Keep it short and first-person.
     */
    self_description?: string;
    /**
     * Delivery direction used when the agent passes no `instructions` of its
     * own — its resting register, not a ceiling. It can still override it
     * per utterance.
     *
     * Honoured only by a model that conditions on an instruction alongside
     * the clone reference (some models do; others silently ignore it).
     */
    default_instructions?: string;
    /**
     * Rate limiting. Speech invites
     * narrating everything, so the default window is deliberately tight.
     */
    rate_limit?: {
      /** Max calls per window. Default 8. */
      max_calls?: number;
      /** Window length in minutes. Default 10. */
      window_minutes?: number;
      /** Max identical utterances per window. Default 2. */
      max_repeats?: number;
    };
  };
  /**
   * Speech recognition — the inbound half of the same audio.cpp server
   * `speech:` serves on the outbound half. When enabled, a Telegram voice
   * note is decoded with ffmpeg, transcribed by POST /v1/audio/transcriptions,
   * and delivered into the conversation as text, with the original audio kept
   * under the Telegram files directory.
   *
   * Enabled by default: before this existed, inbound voice notes were detected
   * and discarded without a word, so the setting that preserves the sender's
   * message is the one that should not need configuring. Set
   * `asr.enabled: false` to go back to dropping them.
   *
   * See src/speech/asr.ts for the failure contract (every failure is silent in
   * the conversation and visible in the log).
   */
  asr?: {
    enabled?: boolean;
    /**
     * Base URL of the audio.cpp server. Defaults to `speech.endpoint`, then to
     * http://127.0.0.1:8091 — one box usually does both directions.
     */
    endpoint?: string;
    /**
     * Server-side ASR model id (audiocpp `models[].id`). Default "asr-small"
     * (Qwen3-ASR-0.6B, ~1.4 s warm here); "asr" is the 1.7B, "asr-fun" the
     * Fun-ASR-Nano — slower, not better on the clips measured so far.
     */
    model?: string;
    /** Request timeout in ms. Default 60000. */
    timeout_ms?: number;
    /**
     * Include the transcript text in the per-note journal line. Default true.
     * Set false to keep the line's ids, model, latency and empty/failed
     * distinction while leaving the words out of the journal — the transcript
     * still reaches the conversation and the session log, and the clip stays
     * on disk, so this is about how far the words spread, not whether they are
     * kept.
     */
    log_transcript?: boolean;
  };
  inbox?: {
    enabled?: boolean;
    mail_root?: string;
    poll_interval_seconds?: number;
    operator_mail_root?: string;
    agent_display_name?: string;
    contacts?: Array<{
      agent_id: string;
      mail_root: string;
      display_name?: string;
      avatar_path?: string;
      capabilities?: string[];
    }>;
  };
  memory?: {
    enabled?: boolean;
    database_path?: string;
    /**
     * Whether to register spindle_memory_store for the main session.
     * Default: true if daydream is off, false if daydream is on.
     * Daydream ephemeral sessions always get the tool regardless.
     */
    main_session_store_tool?: boolean;
    embedding?: {
      provider: string;
      model: string;
      base_url?: string;
      api_key_env?: string;
      dimensions?: number;
    };
    /** Phase 2.1 scoring configuration — linear (default) or act-r. */
    scoring?: {
      mode?: "linear" | "act-r";
      weights?: {
        fts?: number;
        recency?: number;
        frequency?: number;
        similarity?: number;
        link_boost?: number;
        decay_ms?: number;
        saturation?: number;
        link_half_life_ms?: number;
        act_r_d?: number;
        act_r_scale_ms?: number;
      };
    };
    /** Phase 2.1 association-based recall expansion. Default enabled. */
    association?: {
      enabled?: boolean;
      seed_count?: number;
      per_seed?: number;
    };
    /** Phase 5 spindle memory daydream — background auto-store loop. */
    daydream?: {
      enabled?: boolean;
      interval_minutes?: number;
      lookback_minutes?: number;
      min_turns_since_last?: number;
      max_store_per_cycle?: number;
      model?: {
        provider: string;
        model: string;
        thinking_level?: ThinkingLevel;
      };
    };
  };
}

export interface SpindleState {
  config: AgentConfig;
  agentDir: string;
  piDir: string;
}
