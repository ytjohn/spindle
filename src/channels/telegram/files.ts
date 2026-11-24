import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { imagePrompt, voiceSentinel } from "../../media/inbound";
import { getMediaLog, newMediaId } from "../../media/log";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { TelegramApi } from "./api";
import type { TelegramMessage, TelegramPhotoSize } from "./types";
import {
  transcribeAudioFile,
  type AsrOutcome,
  type AsrSettings,
  type AsrTrace,
} from "../../speech/asr";

export type FileKind = "photo" | "document" | "audio" | "voice" | "video" | "video_note";

/**
 * Detects which kind of file (if any) a Telegram message carries.
 * Text messages return null.
 */
export function detectFileKind(message: TelegramMessage): FileKind | null {
  if (message.photo && message.photo.length > 0) return "photo";
  if (message.document) return "document";
  if (message.voice) return "voice";
  if (message.audio) return "audio";
  if (message.video) return "video";
  if (message.video_note) return "video_note";
  return null;
}

/**
 * Result of handling a file: the text to inject into the session as a
 * prompt, or null to drop without dispatching. When `images` is present,
 * the channel attaches them to the user message as native multimodal
 * content (requires a VL-capable model and `native_images: true`).
 *
 * `null` and `{ drop: "silent" }` both stop the message from dispatching, and
 * they differ only in who gets told. `null` means "this kind of file is not
 * handled", so the channel sends the sender a note saying so — better a reply
 * than silence when someone's file went nowhere. `{ drop: "silent" }` means
 * the kind IS handled but this particular file failed, and the failure is
 * ours rather than theirs: say nothing to anyone, keep the file, leave the
 * detail in the log. Voice notes take that path (see handleVoice).
 */
export type FileHandlerResult =
  | string
  | null
  | { prompt: string; images: ImageContent[] }
  | { drop: "silent" };

export interface FileHandlerContext {
  message: TelegramMessage;
  api: TelegramApi;
  filesDir: string;
  /**
   * When true, image handlers attach native ImageContent alongside the
   * text sentinel. Driven by `channels.telegram.native_images`.
   */
  nativeImages: boolean;
  /**
   * Resolved speech-recognition settings, or null when ASR is turned off.
   * Driven by `asr:` in agent.yaml; only voice uses it today.
   */
  asr: AsrSettings | null;
}

export type FileHandler = (ctx: FileHandlerContext) => Promise<FileHandlerResult>;

/**
 * Dispatch table of file handlers keyed by FileKind.
 *
 * Phase 3 implements only `photo`. Other kinds fall through to
 * `handleUnsupported`, which replies politely and drops the message.
 * Adding future support (voice → Whisper, audio → TTS, document →
 * knowledge ingest) is just registering a new handler here.
 *
 * voice landed first: the comment above named it, the ASR server was already
 * running, and meanwhile every voice note sent to every agent was being
 * downloaded and thrown away in the same breath.
 */
export const fileHandlers: Record<FileKind, FileHandler> = {
  photo: handlePhoto,
  document: handleUnsupported("document"),
  audio: handleUnsupported("audio"),
  voice: handleVoice,
  video: handleUnsupported("video"),
  video_note: handleUnsupported("video_note"),
};

async function handlePhoto(ctx: FileHandlerContext): Promise<FileHandlerResult> {
  const photos = ctx.message.photo!;
  const largest = photos.reduce<TelegramPhotoSize>(
    (a, b) => ((b.file_size ?? 0) > (a.file_size ?? 0) ? b : a),
    photos[0]
  );

  const file = await ctx.api.getFile(largest.file_id);
  if (!file.file_path) return null;

  const buffer = await ctx.api.downloadFile(file.file_path);
  const ext = extFromPath(file.file_path) ?? "jpg";
  // With a media log bound, the photo is registered like any other inbound
  // upload and its id goes in the name, so the sentinel line carries the ref
  // a session viewer needs for a thumbnail. Keeps the `tg-<message id>-`
  // prefix that agents' own tools filter received photos by.
  const log = getMediaLog();
  const mediaId = log ? newMediaId() : null;
  const filename = `tg-${ctx.message.message_id}-${mediaId ?? largest.file_unique_id}.${ext}`;

  await ensureDir(ctx.filesDir);
  const absPath = join(ctx.filesDir, filename);
  await writeFile(absPath, buffer);
  if (log && mediaId) {
    log.record({
      id: mediaId,
      session: null,
      type: "image",
      mime: mimeTypeFromExt(ext),
      path: absPath,
      bytes: buffer.length,
      via: "telegram",
      inbound: true,
      ...(ctx.message.caption ? { caption: ctx.message.caption } : {}),
    });
  }

  // Shared with other channels' uploads (src/media/inbound.ts, which carries the
  // rationale for the sentinel and the native-image affirmation line).
  const built = imagePrompt(filename, buffer, mimeTypeFromExt(ext), {
    caption: ctx.message.caption,
    nativeImages: ctx.nativeImages,
  });
  return built.images.length ? built : built.prompt;
}

/**
 * The one journal line every inbound voice note gets, whatever happens to it.
 *
 * Why this exists: a run that worked left no trace at all. The only
 * surviving evidence of four notes once dropped in a day was a count of
 * `unsupported file kind: voice` lines — no id, no clip, nothing that could
 * be re-run or scored. A silent defect ("ollama" coming back as "Alyama")
 * needs a record that lets it be found later, and scored.
 *
 * The convention this follows is the channel's own: `console.log` prefixed
 * `[spindle]`, into stdout, into the systemd journal. There is no structured
 * app log in the harness — `src/telemetry/` is a SQLite record of *turns*
 * (context_stats, compact_events), written by a recorder subscribed to the
 * session, and a voice note is dispatched before a turn exists — so a
 * key=value journal line is the honest shape here, and the transcript is
 * carried in it because the same text is already written verbatim to the
 * session log by the injection below, and can be switched off with
 * `asr.log_transcript: false`.
 *
 * Field order is fixed and null-valued fields are omitted, so
 * `grep '\[spindle\] voice' | grep -o 'outcome=[a-z_]*'` is a working
 * question about what the microphone did this week.
 */
export interface VoiceNoteLogFields {
  /** Telegram's message id, or a string id for a note recorded through another channel. */
  messageId: number | string;
  /** Telegram file_id — while it lives, the only handle that can re-download. */
  fileId: string;
  fileUniqueId: string;
  /** `files/…` as kept on disk, or null when nothing was saved. */
  clip: string | null;
  bytes: number | null;
  /** Seconds, as Telegram reported it; latency is meaningless without it. */
  durationS: number | null;
  outcome: VoiceOutcome;
  model: string | null;
  /** Whether `model` was chosen in agent.yaml or fell back to the constant. */
  modelSource: AsrSettings["modelSource"] | null;
  /** ffmpeg ogg→wav, ms. */
  decodeMs: number | null;
  /** transcription POST, ms. Warm baselines: asr-small 1399, asr 2146, asr-fun 5085. */
  asrMs: number | null;
  /** Whole handler, download included, ms. */
  wallMs: number;
  /** Full length, even when the logged text is capped. */
  transcriptChars: number | null;
  /** The words, capped and single-lined. Null when there were none. */
  transcript: string | null;
  error: string | null;
}

/**
 * `ok`/`empty`/… come from AsrTrace; the first three are the ways a note can
 * fail before ASR is ever asked — and the first two used to leave nothing
 * behind but a stack the channel logs without a message id.
 */
export type VoiceOutcome =
  | "no_file_path"
  | "download_failed"
  | "asr_disabled"
  | AsrOutcome;

/**
 * Just the beginning of the message, matching the inbound-text convention in
 * channel.ts (`preview = text.slice(0, 77) + "..."`): the journal is for
 * "what came in", not a transcript store. The full length travels beside it in
 * `chars=`, and the clip on disk remains the source of truth for the words.
 */
const MAX_TRANSCRIPT_LOG = 77;

/** One line, always. Quotes escaped, newlines and control characters gone. */
function singleLine(text: string): string {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/["\\]/g, "\\$&");
  if (flat.length <= MAX_TRANSCRIPT_LOG) return flat;
  return `${flat.slice(0, MAX_TRANSCRIPT_LOG)}...`;
}

/** Exported for tests: the line is the product, so it is testable on its own. */
export function formatVoiceNoteLogLine(f: VoiceNoteLogFields): string {
  const parts = [
    `[spindle] voice msg=${f.messageId}`,
    `unique=${f.fileUniqueId}`,
    `file_id=${f.fileId}`,
    f.clip ? `clip=${f.clip}` : null,
    f.bytes !== null ? `bytes=${f.bytes}` : null,
    f.durationS !== null ? `dur_s=${f.durationS}` : null,
    `outcome=${f.outcome}`,
    f.model ? `model=${f.model}` : null,
    f.modelSource ? `model_source=${f.modelSource}` : null,
    f.decodeMs !== null ? `decode_ms=${f.decodeMs}` : null,
    f.asrMs !== null ? `asr_ms=${f.asrMs}` : null,
    `wall_ms=${f.wallMs}`,
    f.transcriptChars !== null ? `chars=${f.transcriptChars}` : null,
    f.transcript !== null ? `transcript="${singleLine(f.transcript)}"` : null,
    f.error ? `error="${singleLine(f.error)}"` : null,
  ].filter((p): p is string => p !== null);
  return parts.join(" ");
}

/**
 * Voice notes: download, keep, transcribe, hand the words over as if they
 * had been typed.
 *
 * The file is written before anything is asked of the ASR server, on purpose.
 * Telegram file ids are short-lived, so this download is the only chance
 * anyone will ever have to hold this clip: keeping it means a transcription
 * failure is a missed moment rather than a lost message, and it accumulates
 * the real inbound corpus that ASR entity accuracy gets measured against
 * (there was none at all until now, because every clip was discarded).
 *
 * Everything after the download that could go wrong — no ffmpeg, server down
 * or refusing to load a model under memory pressure, a clip nobody said
 * anything into — returns `{ drop: "silent" }`. The channel's fallback reply
 * ("only images are supported right now") would be false in the mouth of a
 * handler that just accepted the note, and an injected "I couldn't read that"
 * puts our machinery in the sender's message. So the words arrive or nothing
 * does; the log keeps the difference between the two.
 */
async function handleVoice(ctx: FileHandlerContext): Promise<FileHandlerResult> {
  const voice = ctx.message.voice!;
  const startedAt = Date.now();

  // Every exit below records itself first. Partial application because the
  // shape is constant and the outcomes differ; `emit` can never break the
  // note it is describing — a logger that eats a message is worse than one
  // that writes nothing.
  const emit = (fields: Omit<VoiceNoteLogFields, "messageId" | "fileId" | "fileUniqueId">) => {
    try {
      console.log(
        formatVoiceNoteLogLine({
          messageId: ctx.message.message_id,
          fileId: voice.file_id,
          fileUniqueId: voice.file_unique_id,
          ...fields,
        })
      );
    } catch {
      // Deliberately silent: nothing here is worth failing the note over.
    }
  };
  const none = {
    clip: null,
    bytes: null,
    durationS: typeof voice.duration === "number" ? voice.duration : null,
    model: ctx.asr?.model ?? null,
    modelSource: ctx.asr?.modelSource ?? null,
    decodeMs: null,
    asrMs: null,
    transcriptChars: null,
    transcript: null,
    error: null,
  } as const;

  let buffer: Buffer;
  let filename: string;
  try {
    const file = await ctx.api.getFile(voice.file_id);
    if (!file.file_path) {
      emit({
        ...none,
        outcome: "no_file_path",
        wallMs: Date.now() - startedAt,
        error: "getFile returned no file_path",
      });
      return { drop: "silent" };
    }

    buffer = await ctx.api.downloadFile(file.file_path);
    const ext = extFromPath(file.file_path) ?? "ogg";
    filename = `tg-${ctx.message.message_id}-${voice.file_unique_id}.${ext}`;

    await ensureDir(ctx.filesDir);
    await writeFile(join(ctx.filesDir, filename), buffer);
  } catch (err) {
    // Rethrown untouched: `safeDispatchFile` upstream still owns what the
    // sender experiences. What this adds is the message id and file_id that
    // line never had — the two things that make the note recoverable.
    emit({
      ...none,
      outcome: "download_failed",
      wallMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  const clip = `files/${filename}`;
  const saved = { ...none, clip, bytes: buffer.length };

  // Feature off: the audio is still saved, and the channel gives its usual
  // "can't handle that yet" reply — i.e. exactly the pre-ASR behavior.
  if (!ctx.asr) {
    emit({ ...saved, outcome: "asr_disabled", wallMs: Date.now() - startedAt });
    return null;
  }

  let trace: AsrTrace | undefined;
  const text = await transcribeAudioFile(join(ctx.filesDir, filename), ctx.asr, {
    trace: (t) => {
      trace = t;
    },
  });

  // What the model reads is built in src/media/inbound.ts, shared with other channels.
  emit({
    ...saved,
    outcome: trace?.outcome ?? (text ? "ok" : "request_failed"),
    decodeMs: trace?.decodeMs ?? null,
    asrMs: trace?.asrMs ?? null,
    wallMs: Date.now() - startedAt,
    transcript: text && ctx.asr.logTranscript ? text : null,
    transcriptChars: text ? text.length : trace?.outcome === "empty" ? 0 : null,
    error: trace?.error ?? null,
  });

  if (!text) return { drop: "silent" };

  return voiceSentinel({ filename, durationS: voice.duration, model: ctx.asr.model, transcript: text });
}

/** Map a bare file extension (no dot) to an image MIME type. */
function mimeTypeFromExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "jpg":
    case "jpeg":
    default:
      return "image/jpeg";
  }
}

/**
 * Stub handler for unsupported file kinds. Returns a sentinel-ish message
 * indicating to the channel that the file kind is not yet supported so the
 * channel can reply with a friendly note. Returning null drops the message
 * entirely; returning a prompt string dispatches it to the agent.
 *
 * Current behavior: returns null + logs, and the channel sends an OOB reply.
 */
function handleUnsupported(kind: FileKind): FileHandler {
  return async (_ctx) => {
    console.log(`[spindle] Telegram received unsupported file kind: ${kind}`);
    return null;
  };
}

export function extFromPath(path: string): string | null {
  const idx = path.lastIndexOf(".");
  if (idx === -1) return null;
  const ext = path.slice(idx + 1);
  if (!/^[a-z0-9]{1,8}$/i.test(ext)) return null;
  return ext.toLowerCase();
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Dispatches a message's file (if any) to the appropriate handler.
 * Returns the prompt text to inject, or null if the message should be
 * dropped (no file, or unsupported kind).
 */
export async function dispatchFile(
  message: TelegramMessage,
  api: TelegramApi,
  filesDir: string,
  nativeImages = false,
  asr: AsrSettings | null = null
): Promise<{ kind: FileKind; prompt: FileHandlerResult } | null> {
  const kind = detectFileKind(message);
  if (!kind) return null;
  const handler = fileHandlers[kind];
  const prompt = await handler({ message, api, filesDir, nativeImages, asr });
  return { kind, prompt };
}
