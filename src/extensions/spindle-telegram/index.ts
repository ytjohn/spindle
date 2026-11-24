/**
 * spindle-telegram pi extension.
 *
 * Auto-loaded by spindle when `channels.telegram` is configured and
 * `channels.telegram.outbound_tools !== false`. Registers outbound LLM
 * tools that route through the running TelegramChannel via the
 * process-wide binding in `src/channels/telegram/binding.ts`, and
 * subscribes to `tool_execution_end` so the result of
 * `imagine`/`image_edit`/`image_combine`/`compose` (and any other
 * configured `auto_send_tools`) is auto-forwarded to Telegram — as a
 * playable track when the result file is audio, as an image otherwise.
 *
 * Why an extension and not a method on the channel directly: pi tools
 * have to go through the extension loader. The channel already exposes
 * `sendText` / `sendImage` / `sendAudio` as plain public methods, and
 * this extension is a thin adapter that wraps them as pi tools.
 *
 * Daydream-safety: tools register for the `main` load context only.
 * Daydream ephemeral sessions should not be sending Telegram messages
 * — the curator's job is memory, not user-visible output.
 *
 * Keeps the tool contract of the extension it replaced, so an image
 * extension's `suppress_auto_send` + "send it yourself with a caption"
 * response text continues to work unchanged.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { channelCapabilities, declaredChannels } from "../../channels/capabilities";
import { deliver, fromContext } from "../../outbound";
import { Type, type Static } from "@sinclair/typebox";
import {
  getBoundTelegramChannel,
  getTelegramLoadContext,
  getAutoSendTools,
  isOutboundToolsEnabled,
} from "../../channels/telegram/binding";
import { parseFakeToolCalls, primaryArg } from "../../util/fake-tool-calls";
import { getProvenanceTracker, trackerFor } from "../../provenance/binding";

const SendMessageParams = Type.Object({
  message: Type.String({
    description: "The message text to send to the current Telegram chat.",
    minLength: 1,
  }),
});

const SendImageParams = Type.Object({
  path: Type.String({
    description:
      "Path to the image file. Accepts 'files/foo.png' (relative to the channel's files directory), './files/foo.png' (relative to the agent directory), or an absolute path. Must resolve inside the files directory — path traversal is rejected.",
    minLength: 1,
  }),
  caption: Type.Optional(
    Type.String({
      description: "Optional caption to attach to the image.",
    })
  ),
});

const SendAudioParams = Type.Object({
  path: Type.String({
    description:
      "Path to the audio file. Accepts 'files/foo.mp3' (relative to the channel's files directory), './files/foo.mp3' (relative to the agent directory), or an absolute path. Must resolve inside the files directory — path traversal is rejected.",
    minLength: 1,
  }),
  caption: Type.Optional(
    Type.String({
      description: "Optional caption to attach to the audio.",
    })
  ),
  title: Type.Optional(
    Type.String({
      description:
        "Track title shown in the Telegram music player. Without it the player falls back to the raw filename.",
    })
  ),
  performer: Type.Optional(
    Type.String({
      description: "Performer/artist shown in the Telegram music player.",
    })
  ),
  duration: Type.Optional(
    Type.Number({
      description: "Track length in seconds, so the player shows a scrub bar immediately.",
    })
  ),
});

const SendVoiceParams = Type.Object({
  path: Type.String({
    description:
      "Path to the OGG/Opus voice file. Accepts 'files/foo.ogg' (relative to the channel's files directory), './files/foo.ogg' (relative to the agent directory), or an absolute path. Must resolve inside the files directory — path traversal is rejected.",
    minLength: 1,
  }),
  caption: Type.Optional(
    Type.String({
      description: "Optional caption to attach to the voice note.",
    })
  ),
  duration: Type.Optional(
    Type.Number({
      description: "Length in seconds, so the bubble shows a scrub bar immediately.",
    })
  ),
});

/**
 * Extensions the auto-send listener routes to sendAudio instead of
 * sendImage. A `compose` result is an mp3; sending it via sendPhoto
 * would fail at the Telegram API rather than degrade.
 */
const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "aac", "ogg", "opus", "wav", "flac"]);

function isAudioPath(p: string): boolean {
  const dot = p.lastIndexOf(".");
  if (dot === -1) return false;
  return AUDIO_EXTENSIONS.has(p.slice(dot + 1).toLowerCase());
}

export default function spindleTelegramExtension(pi: ExtensionAPI): void {
  if (!isOutboundToolsEnabled()) {
    // Receive-only agent (or outbound_tools explicitly false). Skip
    // everything. No tools, no listeners.
    console.log("[spindle-telegram] outbound_tools disabled — no tools registered");
    return;
  }

  const context = getTelegramLoadContext();
  if (context === "daydream") {
    // Daydream ephemeral sessions don't get telegram send tools — the
    // curator's output is memories, not Telegram messages. Scheduler
    // sessions DO get them: scheduled commands such as a reach-out
    // or notify command exist precisely to send proactive messages, and
    // each entry's `tools:` allowlist still scopes what's active.
    return;
  }

  // Sanity: warn if the binding isn't set yet. In practice this should
  // never happen because spindle constructs the TelegramChannel before
  // createSpindleSession runs (which is what loads this extension), but
  // degrade gracefully if the boot order changes someday.
  if (!getBoundTelegramChannel()) {
    console.warn(
      "[spindle-telegram] loaded without a bound TelegramChannel — telegram outbound tools disabled. " +
        "Channel should be constructed BEFORE createSpindleSession."
    );
    return;
  }

  const autoSendTools = getAutoSendTools();
  console.log(
    `[spindle-telegram] registered telegram_send_message + telegram_send_image + telegram_send_audio + telegram_send_voice; ` +
      `auto-send watching ${autoSendTools.length > 0 ? autoSendTools.join(", ") : "(none)"}`
  );

  pi.registerTool({
    name: "telegram_send_message",
    label: "Send Telegram Message",
    description:
      "Send a text message to the current Telegram chat. Use for explicit " +
      "outbound messages outside the normal assistant-response flow (e.g. " +
      "follow-up after a long-running tool, proactive notifications).",
    promptSnippet: "Send a text message to the Telegram chat.",
    // One guideline per channel whose messages are answered where they
    // were written (channels/capabilities.ts). Read once, here, so the
    // prompt — and its cache — is the same every run. Without it an agent
    // answers such a message twice: in its reply and again by text.
    promptGuidelines: declaredChannels()
      .map(([, caps]) => caps.answersInPlace?.guideline)
      .filter((g): g is string => typeof g === "string" && g.length > 0),
    parameters: SendMessageParams,
    async execute(
      toolCallId,
      params: Static<typeof SendMessageParams>,
      _signal,
      _onUpdate,
      ctx
    ) {
      const channel = getBoundTelegramChannel();
      if (!channel) {
        return {
          content: [{ type: "text", text: "Telegram channel unavailable." }],
          details: { error: "no_channel" },
        };
      }
      try {
        await deliver({ kind: "text", text: params.message, from: fromContext(ctx, toolCallId) });
        return {
          content: [{ type: "text", text: "Message sent to Telegram." }],
          details: { sent: true },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to send message: ${message}` }],
          details: { error: message },
        };
      }
    },
  });

  pi.registerTool({
    name: "telegram_send_image",
    label: "Send Telegram Image",
    description:
      "Send an image file to the current Telegram chat with an optional " +
      "caption. Use AFTER generating an image with imagine/image_edit/" +
      "image_combine when you want to attach a caption (these tools auto-send " +
      "by default unless you pass suppress_auto_send: true).",
    promptSnippet: "Send an image file (with optional caption) to the Telegram chat.",
    promptGuidelines: [],
    parameters: SendImageParams,
    async execute(
      toolCallId,
      params: Static<typeof SendImageParams>,
      _signal,
      _onUpdate,
      ctx
    ) {
      const channel = getBoundTelegramChannel();
      if (!channel) {
        return {
          content: [{ type: "text", text: "Telegram channel unavailable." }],
          details: { error: "no_channel" },
        };
      }
      try {
        await deliver({ kind: "image", path: params.path, caption: params.caption, from: fromContext(ctx, toolCallId) });
        return {
          content: [
            {
              type: "text",
              text: `Image sent to Telegram${params.caption ? ` with caption: ${params.caption}` : ""}.`,
            },
          ],
          details: { sent: true, path: params.path },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to send image: ${message}` }],
          details: { error: message },
        };
      }
    },
  });

  pi.registerTool({
    name: "telegram_send_audio",
    label: "Send Telegram Audio",
    description:
      "Send an audio file to the current Telegram chat as a playable track, " +
      "with an optional caption, title and performer. Use AFTER writing a " +
      "song with compose when you want to attach your own words (compose " +
      "auto-sends by default unless you pass suppress_auto_send: true).",
    promptSnippet: "Send an audio file (with optional caption) to the Telegram chat.",
    promptGuidelines: [],
    parameters: SendAudioParams,
    async execute(
      toolCallId,
      params: Static<typeof SendAudioParams>,
      _signal,
      _onUpdate,
      ctx
    ) {
      const channel = getBoundTelegramChannel();
      if (!channel) {
        return {
          content: [{ type: "text", text: "Telegram channel unavailable." }],
          details: { error: "no_channel" },
        };
      }
      try {
        await deliver({
          kind: "audio",
          path: params.path,
          caption: params.caption,
          title: params.title,
          performer: params.performer,
          duration: params.duration,
          from: fromContext(ctx, toolCallId),
        });
        return {
          content: [
            {
              type: "text",
              text: `Audio sent to Telegram${params.caption ? ` with caption: ${params.caption}` : ""}.`,
            },
          ],
          details: { sent: true, path: params.path },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to send audio: ${message}` }],
          details: { error: message },
        };
      }
    },
  });

  pi.registerTool({
    name: "telegram_send_voice",
    label: "Send Telegram Voice Note",
    description:
      "Send a voice note to the current Telegram chat — the waveform bubble " +
      "with inline playback, which is how spoken words should arrive. Use " +
      "AFTER speaking with a TTS tool when you want to attach a caption " +
      "(speech tools auto-send by default unless you pass " +
      "suppress_auto_send: true). The file must be OGG/Opus; send anything " +
      "else with telegram_send_audio instead.",
    promptSnippet: "Send a voice note (with optional caption) to the Telegram chat.",
    promptGuidelines: [],
    parameters: SendVoiceParams,
    async execute(
      toolCallId,
      params: Static<typeof SendVoiceParams>,
      _signal,
      _onUpdate,
      ctx
    ) {
      const channel = getBoundTelegramChannel();
      if (!channel) {
        return {
          content: [{ type: "text", text: "Telegram channel unavailable." }],
          details: { error: "no_channel" },
        };
      }
      try {
        await deliver({ kind: "voice", path: params.path, caption: params.caption, duration: params.duration, from: fromContext(ctx, toolCallId) });
        return {
          content: [
            {
              type: "text",
              text: `Voice note sent to Telegram${params.caption ? ` with caption: ${params.caption}` : ""}.`,
            },
          ],
          details: { sent: true, path: params.path },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to send voice note: ${message}` }],
          details: { error: message },
        };
      }
    },
  });

  // ------------------------------------------------------------------
  // Auto-send listener
  // ------------------------------------------------------------------
  // Mirrors the listener of the extension this replaced: watch tool_execution_end
  // for successful results of configured image-generation tools and
  // forward the result file to the chat UNLESS suppress_auto_send was
  // set (the convention for "I'll send it myself with a caption").
  //
  // The list of tool names is configured per-agent via
  // channels.telegram.auto_send_tools; default is a typical image extension's
  // contract ["imagine", "image_edit", "image_combine"].
  //
  // Result shape expected: the tool returns `details: { filename: ... }`
  // or `details: { path: ... }`. The default image tools use `filename`.
  // We look for both to stay flexible.
  //
  // Pi's ToolExecutionEndEvent doesn't carry `args`, only `result`, so
  // we cache args at tool_execution_start and look them up at end time.
  // This lets us read `suppress_auto_send` from the original args AND
  // from result.details, as a belt-and-suspenders approach.
  const pendingArgs = new Map<string, Record<string, unknown>>();

  // A run opened from a channel that is answered in place is not also
  // texted. The guideline above says so, and a model will still reason
  // "reply there" and send the text anyway — so the send is refused here,
  // with the channel's reason as the tool result, and the agent answers in
  // plain text. Refusing (rather than removing the tool for the run)
  // leaves the system prompt, and its cache, unchanged.
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "telegram_send_message") return undefined;
    // The tracker of the session this call runs in — a helper session a
    // channel started has its own; the main one is the fallback.
    const tracker = trackerFor(ctx?.sessionManager) ?? getProvenanceTracker();
    const inPlace = channelCapabilities(tracker?.currentRun()?.owner?.channel)?.answersInPlace;
    if (!inPlace) return undefined;
    return { block: true, reason: inPlace.refusal };
  });

  pi.on("tool_execution_start", async (event) => {
    if (typeof event.args === "object" && event.args !== null) {
      pendingArgs.set(event.toolCallId, event.args as Record<string, unknown>);
    }
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    // Always clear the pending entry on end, even when we skip below.
    const args = pendingArgs.get(event.toolCallId) ?? {};
    pendingArgs.delete(event.toolCallId);

    const autoSendTools = getAutoSendTools();
    if (!autoSendTools.includes(event.toolName)) return;

    // Past this point the tool WAS meant to auto-send, so every remaining
    // exit is a surprise worth a line in the journal. Silence here reads
    // as "the file was produced and Telegram simply ate it", which is the
    // hardest kind of failure to chase.
    const skip = (why: string) =>
      console.log(`[spindle-telegram] auto-send skipped ${event.toolName}: ${why}`);

    if (event.isError) return skip("tool reported an error");

    const resultObj =
      typeof event.result === "object" && event.result !== null
        ? (event.result as Record<string, unknown>)
        : {};
    const details =
      typeof resultObj.details === "object" && resultObj.details !== null
        ? (resultObj.details as Record<string, unknown>)
        : {};

    if (args.suppress_auto_send === true || details.suppress_auto_send === true) {
      return skip("suppress_auto_send was set");
    }

    // Pull the filename from result details. Accept `filename` (the image
    // tools' convention) or `path` (generic). Reject anything non-string.
    const filename =
      typeof details.filename === "string"
        ? details.filename
        : typeof details.path === "string"
        ? details.path
        : null;
    if (!filename) {
      return skip(
        `no filename in result details (result keys: ${Object.keys(resultObj).join(",") || "none"}; ` +
          `details keys: ${Object.keys(details).join(",") || "none"})`
      );
    }

    const channel = getBoundTelegramChannel();
    if (!channel) return skip("no telegram channel bound");

    // Optional caption passthrough — some tools stash a caption in
    // details.caption. Left undefined otherwise.
    const caption =
      typeof details.caption === "string" ? details.caption : undefined;

    try {
      if (details.voice_note === true && isAudioPath(filename)) {
        // Speech, not music. Routed on an explicit flag rather than the
        // extension: .ogg is legitimately either, and a song that happened
        // to be encoded as opus would otherwise lose its player metadata.
        await deliver({
          kind: "voice",
          path: filename,
          caption,
          duration: typeof details.duration === "number" ? details.duration : undefined,
          from: fromContext(ctx, event.toolCallId),
          // Streamed speech already has its record (made when the audio began).
          ...(typeof details.media_id === "string" ? { mediaId: details.media_id } : {}),
        });
      } else if (isAudioPath(filename)) {
        // compose-style tools stash player metadata in details; all
        // optional, and sendAudio tolerates them being absent.
        await deliver({
          kind: "audio",
          path: filename,
          caption,
          title: typeof details.title === "string" ? details.title : undefined,
          performer: typeof details.performer === "string" ? details.performer : undefined,
          duration: typeof details.duration === "number" ? details.duration : undefined,
          from: fromContext(ctx, event.toolCallId),
        });
      } else {
        await deliver({ kind: "image", path: filename, caption, from: fromContext(ctx, event.toolCallId) });
      }
    } catch (err) {
      console.error(
        `[spindle-telegram] auto-send failed for ${event.toolName} result ${filename}:`,
        err instanceof Error ? err.message : err
      );
    }
  });

  // ------------------------------------------------------------------
  // Fake-tool-call rescue (outbound tools only)
  // ------------------------------------------------------------------
  // Some locally served models write correct calls as plain
  // text without ever entering tool-use mode. TelegramChannel already
  // masks those spans so a raw prompt string can never be relayed as
  // the reply (see channels/telegram/channel.ts flushCurrentResponse) —
  // but masking alone turns a botched send into silence.
  //
  // Where this extension owns the effect, run the call for the agent. That is
  // exactly the three tools registered above: each is a thin wrapper over
  // channel.sendText / sendImage / sendAudio, so invoking them from here
  // is the same work the tool would have done.
  //
  // NOT rescued here: imagine / image_edit / image_combine / list_images.
  // Their implementation lives in the agent's own extension and pi 0.70
  // exposes no way for one extension to invoke another's tool —
  // getAllTools() returns name, description and parameters, with no
  // executor. Generating from here would mean duplicating that
  // extension's image pipeline, and firing them blind would run
  // the side effect while the model never sees the result. They stay
  // masked and logged instead; closing that gap needs a rescue seam in
  // pi or in the owning extension.
  const RESCUABLE_SENDS = new Set([
    "telegram_send_message",
    "telegram_send_image",
    "telegram_send_audio",
  ]);

  pi.on("message_end", async (event, ctx) => {
    if (getTelegramLoadContext() !== "main") return;
    const channel = getBoundTelegramChannel();
    if (!channel) return;

    const msg = event.message as unknown as Record<string, unknown>;
    const content = Array.isArray(msg?.content) ? (msg.content as unknown[]) : null;
    if (!content) return;

    // A message that carries real tool calls is not the failure mode
    // this rescues — leave it alone.
    const hasRealToolCall = content.some(
      (b) =>
        typeof b === "object" &&
        b !== null &&
        (b as { type?: string }).type === "toolCall",
    );
    if (hasRealToolCall) return;

    const text = content
      .filter(
        (b): b is { type: "text"; text: string } =>
          typeof b === "object" &&
          b !== null &&
          (b as { type?: string }).type === "text" &&
          typeof (b as { text?: unknown }).text === "string",
      )
      .map((b) => b.text)
      .join(" ");
    if (!text.trim()) return;

    for (const call of parseFakeToolCalls(text)) {
      if (!RESCUABLE_SENDS.has(call.name)) continue;
      try {
        if (call.name === "telegram_send_message") {
          const message = primaryArg(call, "message", "text");
          if (!message) continue;
          console.warn(`[spindle-telegram] rescuing faked telegram_send_message`);
          await deliver({ kind: "text", text: message, from: fromContext(ctx) });
        } else if (call.name === "telegram_send_audio") {
          const path = primaryArg(call, "path", "file", "audio");
          if (!path) continue;
          console.warn(`[spindle-telegram] rescuing faked telegram_send_audio: ${path}`);
          await deliver({ kind: "audio", path, caption: call.named.caption, title: call.named.title, performer: call.named.performer, from: fromContext(ctx) });
        } else {
          const path = primaryArg(call, "path", "file", "image");
          if (!path) continue;
          const caption = call.named.caption;
          console.warn(`[spindle-telegram] rescuing faked telegram_send_image: ${path}`);
          await deliver({ kind: "image", path, caption, from: fromContext(ctx) });
        }
      } catch (err) {
        console.error(`[spindle-telegram] rescue of ${call.name} failed:`, err);
      }
    }
  });
}
