import { existsSync, readFileSync, writeFileSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentConfig } from "../../types";
import type { Channel, SlashCommandInfo } from "../types";
import { TelegramApi } from "./api";
import { TelegramPoller } from "./poller";
import { MessageQueue } from "./queue";
import { SingleSessionRouter, parseAllowedUsers, type SessionRouter } from "./sessions";
import { dispatchFile } from "./files";
import { resolveAsrSettings, type AsrSettings } from "../../speech/asr";
import { CommandRegistrar } from "./commands";
import { getProvenanceTracker } from "../../provenance/binding";
import { origin as makeOrigin, type ProvenanceTracker } from "../../provenance/tracker";
import {
  hasCallShapedContent,
  isRelayToolName,
  maskFakeToolCalls,
  parseFakeToolCalls,
  primaryArg,
} from "../../util/fake-tool-calls";
import {
  bindAutoSendTools,
  bindOutboundToolsEnabled,
  bindTelegramChannel,
  bindTelegramPending,
  bindTelegramTurnActive,
  isToolProgressHidden,
} from "./binding";
import {
  createTelegramUIContext,
  createStubCommandContextActions,
} from "./ui-context";
import {
  LocalCommandRegistry,
  createDefaultLocalCommands,
  parseLocalCommand,
} from "./local-commands";
import type {
  TelegramMessage,
  TelegramUpdate,
  UserAccess,
} from "./types";
import { TelegramApiError } from "./types";

// Telegram hard limit is 4096 chars per message. Leave headroom for formatting.
const MAX_TELEGRAM_MESSAGE_LENGTH = 4000;

export interface TelegramChannelOptions {
  agentDir: string;
  config?: AgentConfig;
}

export class TelegramChannel implements Channel {
  readonly name = "telegram";

  private readonly agentDir: string;
  private readonly filesDir: string;
  public get filesDirectory(): string {
    return this.filesDir;
  }
  /** Attach inbound images as native multimodal content. See constructor. */
  private nativeImages = false;
  /** Speech recognition for inbound voice notes; null when `asr.enabled: false`. */
  private asr: AsrSettings | null = null;
  private api: TelegramApi | null = null;
  private poller: TelegramPoller | null = null;
  private readonly queue = new MessageQueue();
  private session: AgentSession | null = null;
  private router: SessionRouter | null = null;
  private allowedUsers: UserAccess[] = [];
  private chatId: number | null = null;
  private busy = false;
  /**
   * True when the current turn was triggered by a Telegram message.
   * Used to gate text accumulation in handleSessionEvent — when a
   * game-channel event (or other non-Telegram source) triggers a turn,
   * the assistant's text response should NOT be forwarded to Telegram.
   */
  /**
   * Turn provenance. Whether the run in flight is ours is
   * a question for the tracker, not a private flag: the run's owner is
   * the Origin of the message that opened it, and another channel's event
   * queued into a run we opened cannot flip it. Replaces the earlier
   * per-channel turn flags.
   */
  private tracker: ProvenanceTracker | null = null;
  private turnUnsubscribe: (() => void) | null = null;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private commandRegistrar: CommandRegistrar | null = null;
  private getSlashCommands: (() => SlashCommandInfo[]) | null = null;
  /**
   * Public so callers can register extra local commands (e.g. `/new`,
   * or app-specific ones) BEFORE calling `start()`.
   *
   *     const channel = new TelegramChannel({ agentDir });
   *     channel.localCommands.register(newSessionCommand);
   *     await channel.start(session, config);
   */
  readonly localCommands = new LocalCommandRegistry();

  constructor(options: TelegramChannelOptions) {
    this.agentDir = options.agentDir;
    // Resolve files directory: explicit config > default <agentDir>/files.
    // Absolute paths pass through; relative paths resolve against agentDir.
    const configured = options.config?.channels?.telegram?.files_directory;
    if (configured) {
      this.filesDir = isAbsolute(configured)
        ? configured
        : resolve(options.agentDir, configured);
    } else {
      this.filesDir = join(options.agentDir, "files");
    }
    // Register built-in local commands. Callers can add more via
    // `channel.localCommands.register()` before `start()` if they want.
    for (const cmd of createDefaultLocalCommands()) {
      this.localCommands.register(cmd);
    }
    // Publish this channel to the process-wide binding so the
    // spindle-telegram pi extension (loaded inside createAgentSession)
    // can find it at register time. Same re-import-safe pattern as
    // src/memory/binding.ts. Must happen in the constructor, not start(),
    // because pi's extension loader runs synchronously during
    // createAgentSession — which happens BEFORE channel.start().
    bindTelegramChannel(this);
    const tg = options.config?.channels?.telegram;
    if (tg?.auto_send_tools) bindAutoSendTools(tg.auto_send_tools);
    bindOutboundToolsEnabled(tg?.outbound_tools !== false);
    this.nativeImages = tg?.native_images === true;
    this.asr = options.config ? resolveAsrSettings(options.config) : null;
  }

  async start(
    session: AgentSession,
    config: AgentConfig,
    getSlashCommands?: () => SlashCommandInfo[]
  ): Promise<void> {
    const tg = config.channels?.telegram;
    if (!tg) throw new Error("TelegramChannel.start called without telegram config");

    this.session = session;
    // Some callers construct with no config and pass the real one here, and
    // ASR is on by default — resolving only in the constructor would leave
    // those agents silently dropping voice notes again. `??=` cannot undo a
    // deliberate `asr.enabled: false`, since every real caller hands the same
    // parsed agent.yaml to both, and that resolve returns null.
    this.asr ??= resolveAsrSettings(config);
    this.allowedUsers = parseAllowedUsers(tg.allowed_users);
    this.router = new SingleSessionRouter(session, this.allowedUsers);
    this.api = new TelegramApi(tg.bot_token);
    this.getSlashCommands = getSlashCommands ?? null;
    // Always create the registrar — even without pi extensions, we still
    // want to register the channel's own local commands.
    this.commandRegistrar = new CommandRegistrar(this.api);

    // Validate the bot token up front, but ONLY treat a genuine auth
    // failure as fatal.
    //
    // This call used to be unconditionally fatal: if it threw, start()
    // aborted before poller.start() below and NOTHING ever retried. The
    // process stayed healthy — scheduler, briefings, memory all fine —
    // while Telegram was permanently dead until someone restarted the
    // service. Every observed occurrence followed a system boot, where
    // the user unit starts before the network is actually reachable, and
    // each left Telegram dead for 11 to 24 hours.
    //
    // An `auth` classification requires an HTTP 401/"unauthorized" reply
    // from Telegram, which means the network worked and the token really
    // is bad or revoked. That stays fatal and loud — retrying cannot fix
    // it, and silently degrading would hide it.
    //
    // Everything else (network unreachable, transport, 5xx, timeout) is
    // transient. Start the poller anyway: its retry loop is proven — 67
    // logged errors across one agent's history, 67 recoveries, zero
    // permanent failures.
    try {
      const me = await this.api.getMe();
      console.log(
        `[spindle] Telegram: connected as @${me.username ?? me.first_name ?? me.id}`,
      );
    } catch (err) {
      if (err instanceof TelegramApiError && err.failureClass === "auth") {
        throw err;
      }
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(
        `[spindle] Telegram: initial getMe failed (${
          err instanceof TelegramApiError ? err.failureClass : "unknown"
        }): ${detail} — starting poller anyway; it will retry until the ` +
          `API is reachable.`,
      );
    }

    // Subscribe to session events directly — we need both the text output
    // (to relay back to Telegram) and the message_end signal (to mark the
    // channel idle and drain the queue). Driving busy/idle from events
    // rather than polling keeps the poll loop from blocking.
    this.turnUnsubscribe = session.subscribe((event) => this.handleSessionEvent(event));

    // Bind the extension UI context + command-context actions at boot.
    // This is what causes pi to emit `session_start` on the extension
    // runner — which in turn fires every registered extension's
    // session_start handler. Extensions that schedule their own work
    // (setInterval loops, poll timers, etc.) only start ticking AFTER
    // this call.
    //
    // Historically we bound on the first allowed message (when chatId
    // became known), which had a visible side effect: background timers
    // didn't start until someone said hello. Binding at boot instead
    // means the notify() closure may be called with chatId still null
    // — sendResponse falls back to stdout in that case, which is what
    // we want for operational "Calendar loaded" / "Scheduler
    // started" messages anyway (journalctl, not chat). When chatId is
    // set by the first allowed message, subsequent notifies route to
    // Telegram as usual.
    //
    // IMPORTANT: bindExtensions must be called exactly once. A second
    // call would cause pi to re-emit session_start and every extension
    // would double-schedule its intervals.
    await this.bindExtensionContext(session);

    this.poller = new TelegramPoller({
      api: this.api,
      onUpdate: (u) => this.handleUpdate(u),
      onError: (err) => this.handlePollerError(err),
      // Fires on the first successful getUpdates. When the initial getMe
      // above failed transiently this is the only signal that Telegram
      // actually came up, so it must be logged.
      onConnected: () => {
        this.pollerLive = true;
        console.log("[spindle] Telegram: poller connected — channel live");
      },
      offsetFile: join(this.agentDir, ".pi", "telegram-offset.json"),
    });
    this.poller.start();

    // Restore persisted chatId so proactive messages (session_start wake-up,
    // on_start_prompt, scheduled notifications) can reach Telegram before
    // the user sends their first message after a restart.
    const chatIdFile = join(this.agentDir, ".pi", "telegram-chat-id.json");
    if (existsSync(chatIdFile)) {
      try {
        const saved = JSON.parse(readFileSync(chatIdFile, "utf-8"));
        if (typeof saved.chatId === "number" && this.chatId === null) {
          const restoredChatId: number = saved.chatId;
          this.chatId = restoredChatId;
          console.log(`[spindle] Telegram: restored chatId ${restoredChatId} from disk`);
          // Sync slash commands so hyphen→underscore mapping works for restored sessions
          void this.syncSlashCommands(restoredChatId);
        }
      } catch { /* ignore corrupt file */ }
    }
  }

  private currentResponseText = "";
  /** Length of currentResponseText at the start of the current message (reset on message_start). */
  private currentMessageStartLength = 0;

  // ----- Tool-call progress state (per turn) -----
  // When the LLM invokes tools during a turn, the channel sends a single
  // Telegram message and edits it in-place as tools start/complete. The
  // message looks like:
  //   ⏳ 12s
  //   ↻ generating image: cute cat
  //   ✓ read files/ref.png
  //
  // On turn completion, the header updates to ✅ (success) or ❌ (error)
  // with the final elapsed time.
  private progressMessageId: number | null = null;
  private progressStartedAt: number = 0;
  private progressActions: Array<{
    id: string;
    label: string;
    status: "running" | "done" | "error";
  }> = [];
  private progressTimerHandle: ReturnType<typeof setInterval> | null = null;
  /** Set when the poller completes its first getUpdates; cleared on auth death. */
  private pollerLive = false;
  /** Epoch ms of the last inbound update. Reported in agent-state.json. */
  private lastInboundAt = 0;

  private handleSessionEvent(event: AgentSessionEvent): void {
    // Event trace: `SPINDLE_TELEGRAM_DEBUG=1` logs every session event
    // so we can verify pi's actual event ordering during live turns.
    if (process.env.SPINDLE_TELEGRAM_DEBUG) {
      const summary = event.type === "message_update"
        ? `message_update:${(event as any).assistantMessageEvent?.type}`
        : event.type === "tool_execution_start"
        ? `tool_execution_start:${(event as any).toolName}`
        : event.type === "tool_execution_end"
        ? `tool_execution_end:${(event as any).toolName}:${(event as any).isError ? "ERR" : "OK"}`
        : event.type;
      console.log(
        `[tg-event] ${summary} | tools=${this.toolsInvolved} active=${this.progressActive} msgId=${this.progressMessageId} actions=${this.progressActions.length}`
      );
    }

    // Keep the flush-fallback timer alive as long as pi is emitting
    // events. Only when the session goes quiet for 5 seconds does the
    // fallback fire. This prevents the timer from triggering between
    // chained tool calls when the LLM thinks for a few seconds.
    if (this.toolsInvolved && event.type !== "agent_end" && this.flushFallbackHandle !== null) {
      this.restartFlushFallbackTimer();
    }

    switch (event.type) {
      case "message_start":
        this.currentMessageStartLength = this.currentResponseText.length;
        break;

      case "message_update":
        // Only accumulate text for runs Telegram owns. Runs opened by
        // other channels should not echo to Telegram.
        if (this.ownsRun()) {
          if (event.assistantMessageEvent.type === "text_delta") {
            this.currentResponseText += event.assistantMessageEvent.delta;
          }
        }
        // Pi emits toolcall_start/end within message_update BEFORE
        // message_end. tool_execution_start fires AFTER message_end.
        // So toolcall_start is our earliest signal that a tool will run.
        if (event.assistantMessageEvent.type === "toolcall_start") {
          this.toolsInvolved = true;
        }
        break;

      case "tool_execution_start": {
        // Cancel any pending fallback — the turn is clearly still alive.
        this.cancelFlushFallbackTimer();
        if (event.toolName === "telegram_send_message" || isRelayToolName(event.toolName)) {
          this.textedThisRun = true;
        }
        // Only show progress in Telegram for Telegram-triggered turns.
        // Also leave out tools another channel has asked to keep quiet
        // (binding.ts hideToolProgress) — even during Telegram turns, the
        // user doesn't need to see that channel's plumbing.
        if (!this.ownsRun()) break;
        if (isToolProgressHidden(event.toolName)) break;
        const label = summarizeToolStart(event.toolName, event.args);
        this.progressActions.push({
          id: event.toolCallId,
          label,
          status: "running",
        });
        this.progressActive = true;

        if (!this.progressMessageId) {
          // First tool call — send the initial progress message.
          this.progressStartedAt = Date.now();
          void this.sendProgressMessage();
        } else {
          // Reuse the existing progress message (may have been
          // finalized after a prior chained message — reactivate it).
          void this.editProgressMessage();
        }
        break;
      }

      case "tool_execution_end": {
        const action = this.progressActions.find(
          (a) => a.id === event.toolCallId
        );
        if (action) {
          action.status = event.isError ? "error" : "done";
          action.label = summarizeToolEnd(
            event.toolName,
            event.result,
            event.isError,
            action.label
          );
        }
        void this.editProgressMessage();
        break;
      }

      case "message_end": {
        const msg = event.message as unknown as Record<string, unknown>;
        const errorMessage = msg?.errorMessage as string | undefined;

        if (this.progressActive) {
          // Finalize progress (edit to ✅) but keep the message id so
          // if another tool starts in a chained message, we can reuse
          // the same Telegram message instead of sending a new one.
          void this.finalizeProgressMessage(!!errorMessage);
          this.progressActive = false;
        }

        // With qwen3.6 on vLLM, the reasoning parser extracts thinking into
        // separate ThinkingContent blocks (reasoning_content → thinking_delta),
        // but the content field still carries </think> residue and/or the
        // response repeated. When ThinkingContent blocks are present, derive
        // the visible text from the assembled content blocks instead of the
        // potentially-contaminated text_delta accumulation.
        //
        // Only process for runs Telegram owns — other runs should not
        // accumulate any text in currentResponseText.
        if (this.ownsRun()) {
        const content = Array.isArray(msg?.content) ? (msg.content as unknown[]) : null;
        if (content) {
          const thinkingParts = content
            .filter(
              (b): b is { type: "thinking"; thinking: string } =>
                typeof b === "object" &&
                b !== null &&
                (b as Record<string, unknown>).type === "thinking" &&
                typeof (b as Record<string, unknown>).thinking === "string"
            )
            .map((b) => b.thinking);

          if (thinkingParts.length > 0) {
            let textFromBlocks = content
              .filter(
                (b): b is { type: "text"; text: string } =>
                  typeof b === "object" &&
                  b !== null &&
                  (b as Record<string, unknown>).type === "text" &&
                  typeof (b as Record<string, unknown>).text === "string"
              )
              .map((b) => b.text)
              .join("");

            // Strip thinking content that leaked as a prefix into the text field.
            for (const thinking of thinkingParts) {
              if (thinking.length > 0 && textFromBlocks.startsWith(thinking)) {
                textFromBlocks = textFromBlocks.slice(thinking.length);
              }
            }

            // Safety net: strip any residual </think> tags.
            textFromBlocks = applyThinkStrip(textFromBlocks);

            // Replace what this message accumulated in currentResponseText.
            this.currentResponseText =
              this.currentResponseText.slice(0, this.currentMessageStartLength) +
              textFromBlocks;
          }
          // No thinking blocks → text_delta accumulation is used as-is;
          // flushCurrentResponse's applyThinkStrip handles edge-case tags.
        }

        // AN ABORT IS NOT AN ERROR TO REPORT. Every one is deliberate — a
        // wait tool ending the turn, the three-strike loop guard, or the
        // operator stopping the run — and none of them is news to the person
        // on the phone. Without this, an agent's texts were followed by
        // "[error] Request aborted". Still logged.
        if (errorMessage && !/^request aborted$/i.test(errorMessage.trim())) {
          this.currentResponseText += `\n[error] ${errorMessage}`;
        }
        } // end ownsRun guard

        // When tools are involved anywhere in this agent run, hold
        // text — agent_end (or the fallback timer) will flush as one
        // message. Pure-text turns flush immediately.
        if (this.toolsInvolved) {
          this.restartFlushFallbackTimer();
        } else {
          this.flushCurrentResponse();
        }

        // Mark channel idle and drain.
        this.busy = false;
        void this.drainQueue();
        break;
      }

      case "agent_end": {
        // True end of the agent run. Flush all accumulated text as one
        // Telegram message, then reset progress state for the next
        // prompt.
        this.cancelFlushFallbackTimer();
        this.flushCurrentResponse();
        this.resetProgress();
        this.textedThisRun = false;
        bindTelegramTurnActive(false);
        // The run is over, so anything the drainQueue isStreaming guard
        // held back can go now. Deferred — see scheduleDrain.
        this.scheduleDrain();
        break;
      }
    }
  }

  /** True while tool calls are in flight within the current message. */
  private progressActive = false;
  /**
   * True once any toolcall_start has been seen in this agent run.
   * Used to hold text across the entire run so it flushes as one
   * message at agent_end. Reset in resetProgress().
   */
  private toolsInvolved = false;
  /**
   * True once telegram_send_message or a relay tool ran in this agent run.
   * The text has reached the user already; what is left over at agent_end is
   * the agent narrating it ("Waiting on one word from them"), and relaying
   * that too is how one reply became three messages.
   */
  private textedThisRun = false;
  /** Silence after a message_end before held text is flushed anyway (agent_end missing). */
  private flushFallbackMs = 5000;
  /** Text of recently delivered messages, so a same-text edit is not a second message. */
  private readonly deliveredText = new Map<number, string>();
  /** When each recent text arrived, to drop a resend under a new message id. */
  private readonly recentTextAt = new Map<string, number>();
  private flushFallbackHandle: ReturnType<typeof setTimeout> | null = null;

  /**
   * (Re)start the fallback flush timer. Called on every message_end
   * when tools are involved. Each call resets the clock so the timer
   * only fires after 5 seconds of silence (no new events). This covers
   * the gap between turns where the LLM thinks for 1-2 seconds.
   *
   * When agent_end arrives it cancels this timer. If agent_end never
   * fires (some pi versions), the fallback ensures text isn't stuck.
   */
  private restartFlushFallbackTimer(): void {
    this.cancelFlushFallbackTimer();
    this.flushFallbackHandle = setTimeout(() => {
      this.flushFallbackHandle = null;
      if (process.env.SPINDLE_TELEGRAM_DEBUG) {
        console.log("[tg-event] flush fallback fired (agent_end did not arrive)");
      }
      this.flushCurrentResponse();
      this.resetProgress();
      // agent_end never arrived — release the other channel's hold too, or
      // its flush would keep re-arming until the max-hold valve.
      bindTelegramTurnActive(false);
    }, this.flushFallbackMs);
  }

  private cancelFlushFallbackTimer(): void {
    if (this.flushFallbackHandle !== null) {
      clearTimeout(this.flushFallbackHandle);
      this.flushFallbackHandle = null;
    }
  }

  private async sendProgressMessage(): Promise<void> {
    if (!this.api || this.chatId === null || this.stopped) return;
    try {
      const text = this.renderProgress();
      const result = await this.api.sendMessage(this.chatId, text);
      this.progressMessageId = result.message_id;
      // Start a timer that re-edits the progress message every 5 seconds
      // so the elapsed time ticks up even if tools haven't emitted events.
      this.startProgressTimer();
    } catch (err) {
      console.error("[spindle] Telegram progress send failed:", err);
    }
  }

  private async editProgressMessage(): Promise<void> {
    if (
      !this.api ||
      this.chatId === null ||
      this.progressMessageId === null ||
      this.stopped
    )
      return;
    try {
      const text = this.renderProgress();
      await this.api.editMessageText(
        this.chatId,
        this.progressMessageId,
        text
      );
    } catch (err) {
      // Telegram returns 400 "message is not modified" when the text
      // hasn't changed. Swallow that — it's harmless.
      const msg = err instanceof Error ? err.message : "";
      if (!msg.includes("not modified")) {
        console.error("[spindle] Telegram progress edit failed:", err);
      }
    }
  }

  private async finalizeProgressMessage(hadError: boolean): Promise<void> {
    this.stopProgressTimer();
    if (this.progressActions.length === 0) return;
    if (
      !this.api ||
      this.chatId === null ||
      this.progressMessageId === null ||
      this.stopped
    )
      return;
    try {
      const elapsed = formatElapsed(Date.now() - this.progressStartedAt);
      const icon = hadError ? "❌" : "✅";
      const actionLines = this.progressActions
        .slice(-MAX_PROGRESS_ACTIONS)
        .map(renderActionLine);
      const text = `${icon} ${elapsed}\n\n${actionLines.join("\n")}`;
      await this.api.editMessageText(
        this.chatId,
        this.progressMessageId,
        text
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (!msg.includes("not modified")) {
        console.error("[spindle] Telegram progress finalize failed:", err);
      }
    }
    // Don't resetProgress() here — keep the message ID so a chained
    // message's tools can reuse the same Telegram message. Full reset
    // happens on agent_end.
  }

  private renderProgress(): string {
    const elapsed = formatElapsed(Date.now() - this.progressStartedAt);
    const header = `⏳ ${elapsed}`;
    const actionLines = this.progressActions
      .slice(-MAX_PROGRESS_ACTIONS)
      .map(renderActionLine);
    return actionLines.length > 0
      ? `${header}\n\n${actionLines.join("\n")}`
      : header;
  }

  private startProgressTimer(): void {
    this.stopProgressTimer();
    this.progressTimerHandle = setInterval(() => {
      void this.editProgressMessage();
    }, 5000);
  }

  private stopProgressTimer(): void {
    if (this.progressTimerHandle !== null) {
      clearInterval(this.progressTimerHandle);
      this.progressTimerHandle = null;
    }
  }

  private resetProgress(): void {
    this.progressMessageId = null;
    this.progressStartedAt = 0;
    this.progressActions = [];
    this.progressActive = false;
    this.toolsInvolved = false;
    // Not textedThisRun: this also runs from the flush fallback, mid-run.
    // It is cleared at agent_end and when a new run starts: the fallback
    // clearing it let an agent's self-talk reach the phone.
    this.stopProgressTimer();
    this.cancelFlushFallbackTimer();
  }

  private flushCurrentResponse(): void {
    const raw = this.currentResponseText;
    this.currentResponseText = "";
    const stripped = applyThinkStrip(raw);
    if (stripped.length === 0) return;
    if (this.textedThisRun) {
      console.log(`[telegram] leftover run text not relayed (already texted this run): ${stripped.slice(0, 100).replace(/\s+/g, " ")}`);
      return;
    }

    // Last line of defence: a tool call the model wrote as prose must
    // never be relayed to a human. An agent once emitted
    // `imagine(prompt="...")` as text on a Telegram turn and the user
    // received the raw image prompt as its reply.
    //
    // Masking here rather than at the call sites is deliberate: this is
    // the single choke point every assistant-text path funnels through,
    // so it holds regardless of which channel triggered the turn or
    // which extension owns the tool. Recovery (actually running the
    // call) belongs to whoever owns the effect — see
    // util/fake-tool-calls.ts. This method only guarantees the leak
    // cannot reach Telegram.
    // hasCallShapedContent, not containsFakeToolCall: the complete-span
    // gate let the malformed-close form `[mud_emote("smirks..."]` (paren
    // dropped, bracket closed) through verbatim.
    if (!hasCallShapedContent(stripped)) {
      void this.sendResponse(stripped);
      return;
    }
    // Relay-tool rescue: such a tool's whole purpose is to send its message
    // to the user — and this reply is already bound for Telegram. Masking
    // it to nothing would throw away the exact content meant to reach them
    // (observed post-compaction: an agent wrote its replies as tool-call
    // prose and every one was suppressed to silence).
    // Extract the message(s) and send them as the reply instead.
    const phoneMessages = parseFakeToolCalls(stripped)
      .filter((c) => isRelayToolName(c.name))
      .map((c) => primaryArg(c, "message", "text"))
      .filter((m) => m.length > 0);
    if (phoneMessages.length > 0) {
      console.warn(
        `[telegram] rescued a message tool written as prose in reply (${phoneMessages.length} msg)`,
      );
      void this.sendResponse(phoneMessages.join("\n\n"));
      return;
    }
    const masked = maskFakeToolCalls(stripped).replace(/\s+/g, " ").trim();
    console.warn(
      `[telegram] suppressed fake tool call in reply: ${stripped.slice(0, 120)}`,
    );
    // Nothing but the call — stay silent rather than send a stray
    // fragment. The turn produced no human-addressed content.
    if (!/\w/.test(masked)) return;
    void this.sendResponse(masked);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.poller) {
      await this.poller.stop();
      this.poller = null;
    }
    this.turnUnsubscribe?.();
    this.turnUnsubscribe = null;
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    this.queue.clear();
    bindTelegramPending(false);
    // Unpublish from the global binding so tests and shutdown paths
    // don't leave a dangling reference to a stopped channel.
    bindTelegramChannel(null);
  }

  private handlePollerError(err: TelegramApiError): void {
    console.error(`[spindle] Telegram poller error (${err.failureClass}): ${err.message}`);
    // The poll loop retries every other failure class itself and has a
    // strong track record doing so, so no recovery path is needed here.
    // `auth` is its ONE terminal branch (poller.ts bumps the generation
    // and breaks the loop) — the token was revoked mid-life. Retrying
    // cannot help, so make it unmissable instead of leaving it as one
    // line among many.
    if (err.failureClass === "auth") {
      this.pollerLive = false;
      console.error(
        "[spindle] Telegram: AUTH FAILURE — the poll loop has stopped " +
          "permanently and this agent can no longer receive Telegram " +
          "messages. The bot token is bad or revoked; fix it and restart " +
          "the service. Restarting alone will not help.",
      );
    }
  }

  /** True once the poller has completed a getUpdates round-trip. */
  isPollerLive(): boolean {
    return this.pollerLive;
  }

  /**
   * Liveness for agent-state.json. `connected` means the poll loop has
   * actually completed a round trip — not that start() was called. That
   * distinction matters: start() once aborted before poller.start() and
   * the channel was silently absent for up to 24h while the process
   * looked perfectly healthy.
   */
  getLiveness(): { connected: boolean; logged_in: boolean; last_activity_at: string | null } {
    return {
      connected: this.pollerLive,
      logged_in: this.pollerLive,
      last_activity_at: this.lastInboundAt ? new Date(this.lastInboundAt).toISOString() : null,
    };
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (this.stopped) return;
    this.lastInboundAt = Date.now();

    // Prefer edited_message over message if both present — edit of a queued item.
    const message = update.edited_message ?? update.message;
    if (!message || !message.from) return;

    const senderId = message.from.id;
    if (message.from.is_bot) return;

    // Session routing (doubles as allowlist check).
    const session = this.router?.resolve(senderId, message.chat.id) ?? null;
    if (!session) return; // not allowed — silently drop

    // Lock in the chat ID from the first allowed message. All outbound
    // messages go here. Multi-chat support is a future enhancement.
    // Extension UI binding (bindExtensionContext) has already run in
    // start() — pre-chatId notifies from session_start handlers logged
    // to stdout; notifies from this point forward route to this chat.
    if (this.chatId === null) {
      this.chatId = message.chat.id;
      // Persist so proactive messages work on next restart before first user message
      try {
        const chatIdFile = join(this.agentDir, ".pi", "telegram-chat-id.json");
        writeFileSync(chatIdFile, JSON.stringify({ chatId: this.chatId }));
      } catch { /* non-fatal */ }
      // Register pi slash commands with Telegram for this chat so users
      // get autocomplete. Fire-and-forget — don't block message handling
      // on the network call; cached by signature on subsequent runs.
      void this.syncSlashCommands(this.chatId);
    }

    // If this is an edited_message and we have a matching queued item that
    // hasn't dispatched yet, update it in place and stop.
    if (update.edited_message && message.text) {
      const edited = this.queue.tryEdit(message.message_id, message.text);
      if (edited) return;
      // Already delivered with the same words: not a new message. One
      // of the user's texts once arrived twice, five minutes apart, and
      // the agent took the copy for its own words coming back.
      if (this.deliveredText.get(message.message_id) === message.text) {
        console.log(`[telegram] dropped same-text edit of delivered message ${message.message_id}`);
        return;
      }
      // else fall through — treat as a new message
    }
    // Same words again within 10 minutes under a new message id: a client
    // resend, not a second message. The user sent once (one bubble on
    // their phone, power-save mode) and the bot received it twice 5.5 min apart.
    if (message.text && !update.edited_message) {
      const now = Date.now();
      for (const [t, at] of this.recentTextAt) if (now - at > 10 * 60_000) this.recentTextAt.delete(t);
      if (this.recentTextAt.has(message.text) && !this.deliveredText.has(message.message_id)) {
        console.log(`[telegram] dropped repeat of a text received ${Math.round((now - this.recentTextAt.get(message.text)!) / 1000)}s ago (msg ${message.message_id}, update ${update.update_id})`);
        return;
      }
      this.recentTextAt.set(message.text, now);
    }
    if (message.text) {
      console.log(`[telegram] << update ${update.update_id} msg ${message.message_id}${update.edited_message ? " (edited)" : ""}`);
      this.deliveredText.set(message.message_id, message.text);
      if (this.deliveredText.size > 200) {
        this.deliveredText.delete(this.deliveredText.keys().next().value as number);
      }
    }

    // Route by content type.
    if (message.text) {
      await this.handleTextMessage(message, session);
      return;
    }

    const fileResult = await this.safeDispatchFile(message);
    if (fileResult === null) return;
    if (fileResult.silent) return; // handler kept the file and chose silence

    if (fileResult.prompt === null) {
      // Unsupported kind — send a polite reply.
      // Fire-and-forget: never block the poll loop on the reply.
      if (detectIsFile(message)) {
        void this.sendResponse(
          "I can't handle that kind of file yet — only images are supported right now."
        );
      }
      return;
    }

    await this.handleFileMessage(message, fileResult.prompt, session, fileResult.images);
  }

  private async safeDispatchFile(
    message: TelegramMessage
  ): Promise<{ prompt: string | null; images?: ImageContent[]; silent?: boolean } | null> {
    if (!this.api) return null;
    try {
      const result = await dispatchFile(
        message,
        this.api,
        this.filesDir,
        this.nativeImages,
        this.asr
      );
      if (!result) return null;
      const prompt = result.prompt;
      // A handler that dropped the file without a word ({ drop: "silent" }) is
      // not the same as a kind nobody handles: the first is our bad day, the
      // second is something the sender deserves to hear about.
      if (prompt && typeof prompt === "object" && "drop" in prompt) {
        return { prompt: null, silent: true };
      }
      if (prompt === null || prompt === undefined) return { prompt: null };
      if (typeof prompt === "string") return { prompt };
      // Rich result: { prompt, images }
      return { prompt: prompt.prompt, images: prompt.images };
    } catch (err) {
      console.error("[spindle] Telegram file dispatch failed:", err);
      return null;
    }
  }

  private async handleTextMessage(
    message: TelegramMessage,
    session: AgentSession
  ): Promise<void> {
    const text = message.text!;
    const sender = message.from?.username ?? message.from?.id ?? "?";
    const preview = text.length > 80 ? text.slice(0, 77) + "..." : text;
    console.log(`[telegram] << @${sender}: ${preview}`);

    // Intercept local commands (e.g. /new, /compact, /session) BEFORE
    // anything else. These are handled by the channel directly, not by
    // pi's prompt() — they need access to AgentSession methods that
    // aren't exposed as extension commands. Unknown slash commands
    // fall through to pi, which will route them to any registered
    // extension handler or pass them to the LLM.
    const parsed = parseLocalCommand(text);
    if (parsed && this.localCommands.has(parsed.name)) {
      if (this.localCommands.get(parsed.name)?.whileBusy) {
        // Acts on the running turn (/stop), so it cannot wait behind it.
        await this.runLocalCommand(parsed.name, parsed.args, session);
        if (this.busy && !session.isStreaming) {
          this.busy = false;
          this.scheduleDrain();
        }
        return;
      }
      if (this.busy) {
        // Don't intercept while an LLM turn is in flight — queue it so
        // order is preserved.
        this.queue.enqueue(text, message.message_id, message.from!.id);
        bindTelegramPending(true);
        return;
      }
      await this.runLocalCommand(parsed.name, parsed.args, session);
      return;
    }

    // Telegram autocomplete only supports underscore-form command names
    // (hyphens are forbidden by the Bot API regex), so an extension that
    // registers `my-command` surfaces as `/my_command` in the UI.
    // When the user taps that entry, we rewrite the text back to the
    // original hyphenated form before handing it to pi's slash router.
    // See src/channels/telegram/commands.ts for the normalization pass.
    const rewritten = this.rewriteCommandText(text);

    if (this.busy || session.isStreaming) {
      this.queue.enqueue(rewritten, message.message_id, message.from!.id);
      bindTelegramPending(true);
      return;
    }
    await this.dispatchToSession(rewritten, session, {
      messageId: message.message_id,
      senderId: message.from?.id,
    });
  }

  /**
   * If the leading `/name` of `text` matches a command that was
   * registered with hyphens and normalized to underscores for Telegram,
   * rewrite it back to the original hyphenated form so pi's slash router
   * can route it. Unknown commands and non-slash text pass through.
   */
  private rewriteCommandText(text: string): string {
    if (!text.startsWith("/") || this.chatId === null || !this.commandRegistrar) {
      return text;
    }
    const parsed = parseLocalCommand(text);
    if (!parsed) return text;
    const original = this.commandRegistrar.getOriginalName(this.chatId, parsed.name);
    if (!original || original.toLowerCase() === parsed.name.toLowerCase()) {
      return text;
    }
    // Preserve the exact argument string (including leading whitespace
    // captured by parseLocalCommand's trim) by slicing the original text.
    const afterName = text.replace(/^\/+[a-z0-9_]+/i, "");
    return `/${original}${afterName}`;
  }

  private async runLocalCommand(
    name: string,
    args: string,
    session: AgentSession
  ): Promise<void> {
    const command = this.localCommands.get(name);
    if (!command) return;
    try {
      await command.handler(args, {
        session,
        reply: (text) => {
          void this.sendResponse(text);
        },
      });
    } catch (err) {
      console.error(`[spindle] Telegram local command /${name} failed:`, err);
      void this.sendResponse(
        `❌ /${name} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async handleFileMessage(
    message: TelegramMessage,
    prompt: string,
    session: AgentSession,
    images?: ImageContent[]
  ): Promise<void> {
    const sender = message.from?.username ?? message.from?.id ?? "?";
    const imgNote = images && images.length > 0 ? ` (+${images.length} native image)` : "";
    console.log(`[telegram] << @${sender}: [file]${imgNote} ${prompt.slice(0, 80)}`);
    // `busy` only tracks turns TELEGRAM started; `session.isStreaming`
    // is the ground truth across all channels. Must match the text path
    // above — an agent can run another channel and telegram on one session,
    // so that channel's turn holds the session with `busy` false.
    if (this.busy || session.isStreaming) {
      this.queue.enqueue(prompt, message.message_id, message.from!.id, images);
      bindTelegramPending(true);
      return;
    }
    await this.dispatchToSession(prompt, session, {
      messageId: message.message_id,
      senderId: message.from?.id,
      images,
    });
  }

  /** Is the run in flight owned by this channel? See `tracker`. */
  private ownsRun(): boolean {
    this.tracker ??= getProvenanceTracker();
    return this.tracker?.isOwnedBy(this.name) ?? false;
  }

  private async dispatchToSession(
    text: string,
    session: AgentSession,
    meta: { messageId?: number; senderId?: number; images?: ImageContent[] } = {}
  ): Promise<void> {
    this.busy = true;
    // A new run starts here unless this lands as a followUp in one in flight.
    if (!session.isStreaming) this.textedThisRun = false;
    // Publish to the shared binding so another channel's flush() can
    // hold its inbound events while this Telegram turn is in flight.
    bindTelegramTurnActive(true);
    try {
      // Fire the prompt. We deliberately do NOT await turn completion
      // here because session idle is tracked via the event subscriber
      // (which flips `busy` to false and drains the queue on
      // `message_end`). Awaiting would block the poller from accepting
      // new updates.
      //
      // `expandPromptTemplates` is left at its default (true) so pi's
      // built-in slash command routing fires. The matching extension
      // handler runs with our bound TelegramUIContext, which redirects
      // `ctx.ui.notify(text)` back to this chat via sendResponse. When
      // a command runs, no LLM turn starts and no message_end fires —
      // the watchdog below unsticks `busy` in that case.
      //
      // Tag with [telegram] so channel-aware extensions can detect the
      // source channel and route responses appropriately.
      //
      // `streamingBehavior` is a net, not the mechanism: the guards on
      // every caller mean we should never reach prompt() while the
      // session is streaming. If a future path misses one, pi queues the
      // message as a follow-up instead of throwing "Agent is already
      // processing" at the user. The two queues do not fight — our own
      // queue only releases a message once the session is idle.
      const tagged = text.startsWith("/") ? text : `[telegram] ${text}`;
      this.tracker ??= getProvenanceTracker();
      let run: Promise<void>;
      if (this.tracker) {
        const origin = makeOrigin(
          this.name,
          { kind: "human", ...(meta.senderId !== undefined ? { id: String(meta.senderId) } : {}) },
          meta.messageId !== undefined ? String(meta.messageId) : undefined
        );
        run = this.tracker.dispatch(tagged, origin, {
          streamingBehavior: "followUp",
          ...(meta.images && meta.images.length > 0 ? { images: meta.images } : {}),
        });
      } else {
        // No tracker bound (tests, or a host that never created one):
        // the message still goes, it just has no origin.
        run = session.prompt(tagged, {
          streamingBehavior: "followUp",
          ...(meta.images && meta.images.length > 0 ? { images: meta.images } : {}),
        });
      }
      // NOT awaited. pi's prompt() resolves only when the whole
      // agent run ends, and the poller awaits each update handler, so
      // awaiting here stopped Telegram polling for the length of the turn:
      // a 37-minute tool loop left every follow-up unread, and a /stop
      // could never have arrived. Completion is tracked by the event
      // subscriber (message_end/agent_end flip `busy` and drain).
      void run.then(
        () => {
          // Safety watchdog: prompt() returned but the session is not
          // streaming (an extension command ran, or the run never started),
          // so no message_end will fire. Unstick the channel so queued
          // messages can drain.
          if (this.stopped || !this.busy) return;
          if (!session.isStreaming) {
            this.busy = false;
            void this.drainQueue();
          }
        },
        async (err) => {
          console.error("[spindle] Session prompt failed:", err);
          await this.sendResponse(
            `[error] Session failed: ${err instanceof Error ? err.message : String(err)}`
          );
          // On a hard failure the session never emits message_end — unblock
          // ourselves and drain anyway.
          this.busy = false;
          void this.drainQueue();
        }
      );
    } catch (err) {
      // Synchronous throw before a promise existed.
      console.error("[spindle] Session prompt failed:", err);
      await this.sendResponse(
        `[error] Session failed: ${err instanceof Error ? err.message : String(err)}`
      );
      this.busy = false;
      void this.drainQueue();
    }
  }

  /**
   * Retry the drain on a later macrotask.
   *
   * `isStreaming` is cleared by the agent's `finally` block, which runs
   * AFTER agent_end listeners return — so a drain called synchronously
   * from an event handler still observes a streaming session. A
   * setTimeout(0) lands after that `finally`. Coalesced to one pending
   * timer so repeated events don't stack drains.
   */
  private scheduleDrain(): void {
    if (this.drainTimer || this.stopped) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      void this.drainQueue();
    }, 0);
  }

  private async drainQueue(): Promise<void> {
    if (this.busy || this.stopped) return;
    // Peek before popping: if the session turns out to be streaming we
    // must leave the message queued, not drop it on the floor.
    const pending = this.queue.peek();
    if (!pending) return;
    const session = this.router?.resolve(pending.senderId, this.chatId ?? 0);
    if (!session) return;
    // Third site of the same busy/isStreaming asymmetry. message_end fires
    // per assistant message, so a multi-message turn drains here while
    // the session is still streaming. Wait for the run to actually end.
    if (session.isStreaming) {
      this.scheduleDrain();
      return;
    }
    const next = this.queue.dispatch();
    if (!next) return;
    if (!this.queue.peek()) bindTelegramPending(false);

    // Same local command interception as handleTextMessage — a queued
    // /new or /compact should route through the local registry, not
    // through the LLM prompt path. Queued text was already rewritten
    // at enqueue time, so no second rewrite is needed here.
    const parsed = parseLocalCommand(next.text);
    if (parsed && this.localCommands.has(parsed.name)) {
      await this.runLocalCommand(parsed.name, parsed.args, session);
      // runLocalCommand is synchronous with respect to busy state — no
      // LLM turn, no message_end — so chain drain manually.
      void this.drainQueue();
      return;
    }

    await this.dispatchToSession(next.text, session, {
      messageId: next.telegramMessageId,
      senderId: next.senderId,
      images: next.images,
    });
  }

  private async bindExtensionContext(session: AgentSession): Promise<void> {
    // `bindExtensions` is a Pi SDK method that installs a UI adapter and
    // command-context actions on the current extension runner. Without it,
    // extension command handlers that call `ctx.ui.notify(...)` would try
    // to write to a TTY that doesn't exist.
    //
    // Declared via an interface because `AgentSession` in older versions
    // of the SDK may not expose it — degrade gracefully if it's missing.
    const withBind = session as unknown as {
      bindExtensions?: (bindings: {
        uiContext?: unknown;
        commandContextActions?: unknown;
      }) => Promise<void>;
    };
    if (typeof withBind.bindExtensions !== "function") {
      console.warn(
        "[spindle] Telegram: session.bindExtensions not available — extension commands via slash will fall back to text"
      );
      return;
    }
    try {
      await withBind.bindExtensions({
        uiContext: createTelegramUIContext({
          notify: (message, _type) => {
            // Fire-and-forget: the extension handler expects notify() to
            // be synchronous. We dispatch the actual send asynchronously.
            void this.sendResponse(message);
          },
        }),
        commandContextActions: createStubCommandContextActions(),
      });
    } catch (err) {
      console.error("[spindle] Telegram: bindExtensions failed:", err);
    }
  }

  private async syncSlashCommands(chatId: number): Promise<void> {
    if (!this.commandRegistrar) return;
    try {
      // Merge pi-extension commands with the channel's own local commands
      // so both appear in Telegram's autocomplete. Local commands take
      // precedence when names collide (they're dispatched first, so the
      // extension version would be unreachable anyway).
      const piCommands = this.getSlashCommands?.() ?? [];
      const localCommands = this.localCommands.asSlashCommandInfo();
      const localNames = new Set(localCommands.map((c) => c.name.toLowerCase()));
      const merged = [
        ...localCommands,
        ...piCommands.filter((c) => !localNames.has(c.name.toLowerCase())),
      ];
      await this.commandRegistrar.syncForChat(chatId, merged);
    } catch (err) {
      console.error("[spindle] Telegram slash command registration failed:", err);
    }
  }

  private async sendResponse(text: string): Promise<void> {
    if (this.stopped) return;
    // Pre-chat-id fallback: extensions' session_start handlers fire at
    // boot (via bindExtensionContext called from start()) and often
    // call ctx.ui.notify() with operational messages like "Calendar
    // loaded" or "Scheduler started". No chat has been locked
    // in yet, so there's nowhere to send them. Log to stdout so they
    // surface in journalctl — that's where operational messages belong
    // anyway. Skip empty strings.
    if (!this.api || this.chatId === null) {
      const trimmed = text.trim();
      if (trimmed.length > 0) {
        console.log(`[telegram] pre-chat: ${trimmed}`);
      }
      return;
    }
    try {
      const chunks = splitForTelegram(text).filter((c) => c.trim().length > 0);
      if (chunks.length > 0) {
        const caller = process.env.SPINDLE_TELEGRAM_DEBUG
          ? ` [${new Error().stack?.split("\n")[2]?.trim().slice(0, 80) ?? "?"}]`
          : "";
        console.log(`[telegram] >> reply (${text.length} chars, ${chunks.length} chunk(s))${caller}`);
      }
      for (const chunk of chunks) {
        await this.api.sendMessage(this.chatId, chunk);
      }
    } catch (err) {
      console.error("[spindle] Telegram sendMessage failed:", err);
    }
  }

  /**
   * Public API: send a text message to the current chat. Used by the
   * spindle-telegram pi extension's `telegram_send_message` tool.
   *
   * Throws when no chat has been locked in yet (no allowed user has
   * messaged the bot), when the channel has been stopped, or when the
   * underlying Bot API call fails.
   */
  async sendText(message: string): Promise<void> {
    if (this.stopped) throw new Error("Telegram channel stopped");
    if (!this.api) throw new Error("Telegram channel not started");
    if (this.chatId === null) {
      throw new Error(
        "Telegram chat not yet locked in — no allowed user has messaged the bot"
      );
    }
    // Sanitize here, not only in flushCurrentResponse: this method is
    // also the delivery path for TOOL payloads (telegram_send_message and
    // relay tools), which bypassed relay masking — a text-shaped call
    // inside such a message reached the user verbatim. Masking is a no-op
    // on clean text.
    if (hasCallShapedContent(message)) {
      const masked = maskFakeToolCalls(message).replace(/\s+/g, " ").trim();
      console.warn(
        `[telegram] sanitized call-shaped content in sendText: ${message.slice(0, 100)}`,
      );
      if (!/\w/.test(masked)) return;
      message = masked;
    }
    const chunks = splitForTelegram(message).filter((c) => c.trim().length > 0);
    if (chunks.length === 0) return;
    console.log(`[telegram] >> sendText (${message.length} chars, ${chunks.length} chunk(s))`);
    for (const chunk of chunks) {
      await this.api.sendMessage(this.chatId, chunk);
    }
  }

  /**
   * Public API: send an image file to the current chat. Used by the
   * spindle-telegram pi extension's `telegram_send_image` tool and by
   * the auto-send listener that forwards `imagine`/`image_edit`/
   * `image_combine` tool results.
   *
   * Path resolution:
   *   - Absolute path (e.g. `/tmp/foo.png`) → use as-is
   *   - Relative path (e.g. `cat.png`, `subdir/cat.png`) → resolved
   *     inside `filesDir` regardless of cwd
   *
   * A `./files/foo.png`-style leading segment is NOT automatically
   * stripped — pass the bare filename (`foo.png`) instead.
   *
   * Path-traversal guard: after resolution, the path must live inside
   * `filesDir`. Crafted filenames like `../../etc/passwd` get rejected.
   */
  /**
   * Resolve an outbound file path and read it, enforcing that it lives
   * inside filesDir. Shared by sendImage / sendAudio so both send paths
   * get the same traversal guard.
   */
  private resolveOutboundFile(
    filePath: string,
    fallbackName: string
  ): { data: Buffer; filename: string; path: string } {
    if (this.stopped) throw new Error("Telegram channel stopped");
    if (!this.api) throw new Error("Telegram channel not started");
    if (this.chatId === null) {
      throw new Error(
        "Telegram chat not yet locked in — no allowed user has messaged the bot"
      );
    }

    const resolved = isAbsolute(filePath)
      ? filePath
      : join(this.filesDir, filePath);

    // Path-traversal guard: the resolved path MUST live inside filesDir.
    // Uses a prefix check with a trailing separator to avoid
    // `/foo/files-evil` sneaking past a naive `startsWith(/foo/files)`.
    const normalizedFilesDir = resolve(this.filesDir);
    const normalizedResolved = resolve(resolved);
    const inside =
      normalizedResolved === normalizedFilesDir ||
      normalizedResolved.startsWith(normalizedFilesDir + "/");
    if (!inside) {
      throw new Error(
        `Refusing to send ${filePath}: resolved path is outside filesDir (${normalizedFilesDir})`
      );
    }

    if (!existsSync(normalizedResolved)) {
      throw new Error(`File not found: ${normalizedResolved}`);
    }

    return {
      data: readFileSync(normalizedResolved),
      filename: normalizedResolved.split("/").pop() || fallbackName,
      path: normalizedResolved,
    };
  }

  async sendImage(filePath: string, caption?: string): Promise<{ path: string; bytes: number }> {
    const { data, filename, path } = this.resolveOutboundFile(filePath, "image.png");
    console.log(`[telegram] >> sendImage: ${filename}${caption ? ` (caption: ${caption.slice(0, 40)}...)` : ""}`);
    await this.api!.sendPhoto(this.chatId!, data, filename, caption);
    return { path, bytes: data.length };
  }

  async sendAudio(
    filePath: string,
    caption?: string,
    meta?: { title?: string; performer?: string; duration?: number }
  ): Promise<{ path: string; bytes: number }> {
    const { data, filename, path } = this.resolveOutboundFile(filePath, "audio.mp3");
    console.log(`[telegram] >> sendAudio: ${filename}${meta?.title ? ` ("${meta.title}")` : ""}${caption ? ` (caption: ${caption.slice(0, 40)}...)` : ""}`);
    await this.api!.sendAudio(this.chatId!, data, filename, caption, meta);
    return { path, bytes: data.length };
  }

  /**
   * Send a voice note. Same traversal guard as sendImage/sendAudio; the
   * difference from sendAudio is purely how Telegram renders it — speech
   * from the agent belongs in a voice bubble, not the music player.
   *
   * The file must already be OGG/Opus (see api.sendVoice).
   */
  async sendVoice(
    filePath: string,
    caption?: string,
    meta?: { duration?: number }
  ): Promise<{ path: string; bytes: number }> {
    const { data, filename, path } = this.resolveOutboundFile(filePath, "voice.ogg");
    console.log(`[telegram] >> sendVoice: ${filename}${meta?.duration ? ` (${Math.round(meta.duration)}s)` : ""}${caption ? ` (caption: ${caption.slice(0, 40)}...)` : ""}`);
    await this.api!.sendVoice(this.chatId!, data, filename, caption, meta);
    return { path, bytes: data.length };
  }
}


// ----- Think-tag stripping -----

/**
 * Strip Qwen3 thinking leakage from raw accumulated text before sending to Telegram.
 *
 * vLLM's reasoning parser extracts the <think> block into reasoning_content, but
 * the content field can still carry </think> residue and/or the response repeated
 * (qwen3.6 "response-inside-think-block" pattern). Take only what follows the
 * last </think> as the definitive response; fall back to stripping orphaned tags
 * if nothing meaningful remains after the last close tag.
 */
function applyThinkStrip(raw: string): string {
  const thinkEnd = raw.lastIndexOf("</think>");
  const afterThink = thinkEnd >= 0 ? raw.slice(thinkEnd + "</think>".length).trim() : raw;
  const base = afterThink.length > 0 ? afterThink : raw.replace(/<\/think>/g, "");
  return base.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

// ----- Progress rendering helpers -----

const MAX_PROGRESS_ACTIONS = 5;

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

/** Human-readable summary of a tool starting. */
function summarizeToolStart(toolName: string, args: unknown): string {
  const record =
    typeof args === "object" && args !== null
      ? (args as Record<string, unknown>)
      : {};
  switch (toolName) {
    case "read":
      return `reading ${truncate(String(record.path ?? "file"), 60)}`;
    case "imagine":
      return `🎨 generating image: ${truncate(String(record.prompt ?? "image"), 60)}`;
    case "image_edit":
      return `🎨 editing image`;
    case "image_combine":
      return `🎨 combining images`;
    case "telegram_send_message":
      return `📨 sending message`;
    case "telegram_send_image":
      return `📷 sending image`;
    case "write":
      return `writing ${truncate(String(record.path ?? "file"), 60)}`;
    case "edit":
      return `editing ${truncate(String(record.path ?? "file"), 60)}`;
    case "bash":
      return `running ${truncate(String(record.command ?? "command"), 80)}`;
    case "memory_store":
    case "spindle_memory_store":
      return `🧠 storing memory`;
    case "memory_recall":
    case "spindle_memory_recall":
      return `🧠 recalling memories`;
    default:
      return `using ${toolName}`;
  }
}

/** Human-readable summary of a tool completing. */
function summarizeToolEnd(
  toolName: string,
  result: unknown,
  isError: boolean,
  startLabel: string
): string {
  if (isError) return `failed: ${startLabel}`;
  const details =
    typeof result === "object" && result !== null
      ? (result as Record<string, unknown>)
      : {};
  if (toolName === "imagine" || toolName === "image_edit" || toolName === "image_combine") {
    const inner =
      typeof details.details === "object" && details.details !== null
        ? (details.details as Record<string, unknown>)
        : {};
    const filename = inner.filename ?? inner.path ?? "image";
    return `🎨 generated ${truncate(String(filename), 60)}`;
  }
  if (toolName === "memory_store" || toolName === "spindle_memory_store") {
    // Pull the stored fact from the content array
    const content = Array.isArray(details.content) ? details.content : [];
    const textItem = content.find(
      (c: unknown) =>
        typeof c === "object" && c !== null && (c as { type?: string }).type === "text"
    ) as { text?: string } | undefined;
    if (textItem?.text) return `🧠 ${truncate(textItem.text, 80)}`;
    return `🧠 memory stored`;
  }
  if (toolName === "memory_recall" || toolName === "spindle_memory_recall") {
    const inner =
      typeof details.details === "object" && details.details !== null
        ? (details.details as Record<string, unknown>)
        : {};
    const count = typeof inner.count === "number" ? inner.count : "?";
    return `🧠 recalled ${count} memories`;
  }
  // Generic fallback
  return startLabel.replace(/^(reading|writing|editing|running|using)/, "completed");
}

function renderActionLine(action: {
  label: string;
  status: "running" | "done" | "error";
}): string {
  const prefix =
    action.status === "done" ? "✓" : action.status === "error" ? "✗" : "↻";
  return `${prefix} ${action.label}`;
}

function detectIsFile(message: TelegramMessage): boolean {
  return !!(
    message.photo ||
    message.document ||
    message.audio ||
    message.voice ||
    message.video ||
    message.video_note
  );
}

/**
 * Split a response into Telegram-sized chunks. Prefers splitting on newline
 * boundaries within the last ~10% of the max length to avoid mid-sentence cuts.
 */
export function splitForTelegram(text: string, maxLength = MAX_TELEGRAM_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    const slice = remaining.slice(0, maxLength);
    const softBoundary = Math.max(
      slice.lastIndexOf("\n\n"),
      slice.lastIndexOf("\n"),
      slice.lastIndexOf(". ")
    );
    const cutAt = softBoundary > maxLength * 0.5 ? softBoundary + 1 : maxLength;
    chunks.push(remaining.slice(0, cutAt).trimEnd());
    remaining = remaining.slice(cutAt).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
