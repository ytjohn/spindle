/**
 * spindle-speak — lets the agent answer in its own voice.
 *
 * Auto-injected when `speech.enabled` is set in agent.yaml. Registers a
 * single `speak` tool: text in, a Telegram voice note out.
 *
 * Deliberately ONE tool. A model such as Qwen3 served via vLLM drops out
 * of tool-use mode as the active set grows, so a `list_speech` / `replay`
 * suite would cost more than it gives. Past utterances are ordinary files;
 * the agent can find them with the tools it already has.
 *
 * Pipeline:
 *   POST <endpoint>/v1/audio/speech   (OpenAI-shaped, audio.cpp server)
 *     -> wav bytes
 *     -> ffmpeg -c:a libopus          (Telegram renders a voice note only
 *                                      for OGG/Opus; anything else is
 *                                      silently demoted to a document)
 *     -> <outputDir>/speak_<ts>.ogg
 *     -> details { filename, duration, voice_note: true }
 *
 * That last shape is the auto-send contract: spindle-telegram forwards
 * the file and routes it to sendVoice because voice_note is set. No
 * delivery code lives here.
 *
 * The agent's identity is `speech.voice` — a named preset on the audio.cpp
 * server, not a parameter of this tool. The agent cannot pick a different
 * voice any more than it can pick a different name.
 *
 * Delivery, though, is its own: the optional `instructions` parameter directs
 * mood, energy and pacing on top of that fixed identity. The clone
 * reference still sets WHO is speaking, so this cannot be used to become
 * someone else — only to sound tired, or wry, or careful. Requires a model
 * that conditions on an instruction alongside the reference; see the note
 * at the request body below.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { channelCapabilities } from "../../channels/capabilities";
import { Type, type Static } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { getSpeechSettings, type SpeechSettings } from "../../speech/binding";
import { getMediaLog, newMediaId } from "../../media/log";
import { closeLiveAudio, getLiveAudio, openLiveAudio } from "../../media/live";
import { getProvenanceTracker, trackerFor } from "../../provenance/binding";
import { getTelegramLoadContext } from "../../channels/telegram/binding";

const execFileAsync = promisify(execFile);

/** What the speech server streams: mono signed 16-bit little-endian PCM at this rate (the offline WAV is the same). */
export const STREAM_RATE = 24_000;

/**
 * Streamed speech: ask the server for the audio as it is
 * generated, and let a listener start on the first chunk.
 *
 * The note gets its media record when the first audio arrives, marked
 * `streaming`, with the audio held in `media/live.ts`; a channel's
 * media route serves it from there. When the stream ends the PCM is encoded
 * to the same OGG/Opus file the one-shot path writes, the record becomes an
 * ordinary finished one, and everything downstream (auto-send to Telegram,
 * history, replay) sees exactly what it always has.
 *
 * Returns null when streaming could not start (no streaming model on the
 * server, an error before any audio): the caller then takes the one-shot
 * path, so a streaming fault never costs an utterance. Once audio has
 * started, a fault throws: half a note has been heard, and saying it all
 * again from the top would be worse than saying so.
 */
export async function speakStreamed(o: {
  settings: Pick<SpeechSettings, "endpoint" | "voice" | "streamModel" | "streamFramesPerEvent" | "streamLookaheadMargin">;
  text: string;
  instructions?: string;
  signal: AbortSignal;
  oggPath: string;
  session: string | null;
  toolCallId?: string;
  caption?: string;
  fetchImpl?: typeof fetch;
  encode?: (pcmPath: string, oggPath: string) => Promise<void>;
}): Promise<{ duration: number; bytes: number; mediaId: string; firstAudioMs: number } | null> {
  const log = getMediaLog();
  if (!o.settings.streamModel || !log) return null;
  const started = Date.now();
  const body: Record<string, unknown> = {
    model: o.settings.streamModel,
    input: o.text,
    stream: true,
    stream_format: "audio",
    response_format: "pcm",
    options: {
      stream_frames_per_event: String(o.settings.streamFramesPerEvent),
      stream_lookahead_margin: String(o.settings.streamLookaheadMargin),
    },
  };
  if (o.settings.voice) body.voice = o.settings.voice;
  if (o.instructions) body.instructions = o.instructions;

  let resp: Response;
  try {
    resp = await (o.fetchImpl ?? fetch)(`${o.settings.endpoint}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: o.signal,
    });
  } catch (err) {
    if (o.signal.aborted) throw err;
    console.log(`[spindle-speak] streaming unavailable (${err instanceof Error ? err.message : String(err)}); using the one-shot path`);
    return null;
  }
  if (!resp.ok || !resp.body) {
    const detail = (await resp.text().catch(() => "")).slice(0, 200);
    console.log(`[spindle-speak] streaming refused (${resp.status}${detail ? `: ${detail}` : ""}); using the one-shot path`);
    return null;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  let mediaId: string | null = null;
  let firstAudioMs = 0;
  const reader = resp.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      if (!mediaId) {
        mediaId = newMediaId();
        firstAudioMs = Date.now() - started;
        const live = openLiveAudio(mediaId, STREAM_RATE);
        live.write(value);
        log.record({
          id: mediaId,
          type: "voice",
          mime: "audio/ogg",
          path: o.oggPath,
          bytes: 0,
          via: "telegram",
          streaming: true,
          session: o.session,
          ...(o.toolCallId ? { toolCallId: o.toolCallId } : {}),
          ...(o.caption ? { caption: o.caption } : {}),
        });
      } else {
        openLiveAudioWrite(mediaId, value);
      }
      chunks.push(value);
      total += value.length;
    }
  } catch (err) {
    if (!mediaId) {
      if (o.signal.aborted) throw err;
      console.log(`[spindle-speak] stream failed before any audio (${err instanceof Error ? err.message : String(err)}); using the one-shot path`);
      return null;
    }
    log.update(mediaId, { streaming: false });
    closeLiveAudio(mediaId);
    throw err;
  }
  if (!mediaId || total === 0) return null;

  try {
    const pcmPath = o.oggPath.replace(/\.ogg$/, ".pcm");
    writeFileSync(pcmPath, Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))));
    try {
      await (o.encode ?? encodePcmToOgg)(pcmPath, o.oggPath);
    } finally {
      try {
        unlinkSync(pcmPath);
      } catch {
        /* best effort */
      }
    }
    const bytes = readFileSync(o.oggPath).length;
    const duration = Math.floor(total / 2) / STREAM_RATE;
    // The file first, then the held audio: a reader that arrives in between finds one or the other.
    log.update(mediaId, { streaming: false, bytes, durationMs: Math.round(duration * 1000) });
    closeLiveAudio(mediaId);
    return { duration, bytes, mediaId, firstAudioMs };
  } catch (err) {
    log.update(mediaId, { streaming: false });
    closeLiveAudio(mediaId);
    throw err;
  }
}

function openLiveAudioWrite(id: string, chunk: Uint8Array): void {
  getLiveAudio(id)?.write(chunk);
}

async function encodePcmToOgg(pcmPath: string, oggPath: string): Promise<void> {
  await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "s16le", "-ar", String(STREAM_RATE), "-ac", "1", "-i", pcmPath,
      "-c:a", "libopus", "-b:a", "32k", "-ar", "48000", "-ac", "1",
      oggPath,
    ],
    { timeout: 60_000 }
  );
}

const SpeakParams = Type.Object({
  text: Type.String({
    description:
      "What to say, in your own words. Written to be HEARD, not read: plain sentences, no markdown, no code, no lists, no emoji. Spell out anything that would be read aloud awkwardly.",
    minLength: 1,
  }),
  caption: Type.Optional(
    Type.String({
      description:
        "Optional caption shown under the voice note. Leave it out and the spoken words are used, so the note can be read without playing it — only set this when something OTHER than a transcript belongs there, such as a link or a spelling the ear would miss.",
    })
  ),
  instructions: Type.Optional(
    Type.String({
      description:
        "Optional direction for HOW to say it — mood, energy, pacing, setting. Not what to say, and not who you are: your voice stays yours. Plain description, e.g. \"tired but happy, soft spoken, talking on the phone late at night\" or \"quick and wry, grinning\". Use it when the delivery carries meaning the words alone do not; leave it out for ordinary speech.",
    })
  ),
  // No suppress_auto_send here, deliberately — `compose` has one because a
  // song is a work product worth reviewing before you caption it, but for
  // speech, arriving in the chat IS the point. The single reason to
  // suppress (add your own caption) is already covered by `caption` above,
  // so the flag would only ever produce a voice note that goes nowhere.
  // It is also a footgun to hand a model: an agent asked to "test the
  // speak tool" is exactly the caller who sets it and then wonders why
  // nothing arrived. The listener still honours it from other tools.
});

/**
 * Duration in seconds from a PCM wav header.
 *
 * Chunk-walked rather than read at a fixed offset: audio.cpp's wav writer
 * is free to emit LIST/fact chunks before `data`, and a hardcoded offset
 * would silently produce a wrong scrub bar rather than fail.
 *
 * Returns undefined on anything unexpected — duration is a nicety that
 * fills the scrub bar early, never a reason to lose the audio.
 */
export function wavDurationSeconds(buf: Buffer): number | undefined {
  try {
    if (buf.length < 12) return undefined;
    if (buf.toString("ascii", 0, 4) !== "RIFF") return undefined;
    if (buf.toString("ascii", 8, 12) !== "WAVE") return undefined;

    let byteRate = 0;
    let offset = 12;
    while (offset + 8 <= buf.length) {
      const id = buf.toString("ascii", offset, offset + 4);
      const size = buf.readUInt32LE(offset + 4);
      const body = offset + 8;
      if (id === "fmt " && body + 16 <= buf.length) {
        byteRate = buf.readUInt32LE(body + 8);
      } else if (id === "data") {
        if (!byteRate) return undefined;
        // Trust the smaller of the declared size and what actually
        // arrived: a truncated download would otherwise report the full
        // intended length.
        const actual = Math.min(size, buf.length - body);
        return actual / byteRate;
      }
      // Chunks are word-aligned: an odd size carries a pad byte.
      offset = body + size + (size % 2);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Telegram caps a caption at 1024 characters and rejects the whole send if
 * it is longer — so a long utterance must lose its tail rather than its
 * voice note.
 */
const TELEGRAM_CAPTION_LIMIT = 1024;

export function captionForUtterance(
  text: string,
  explicit: string | undefined,
  mode: "transcript" | "none"
): string | undefined {
  // An explicit caption always wins: the model asked for something the
  // transcript is not.
  if (explicit !== undefined && explicit.trim() !== "") return explicit;
  if (mode === "none") return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= TELEGRAM_CAPTION_LIMIT) return flat;
  return flat.slice(0, TELEGRAM_CAPTION_LIMIT - 1).trimEnd() + "…";
}

/** Rate-limit state, module-level so it survives within one process. */
const recentCalls: Array<{ ts: number; key: string }> = [];

export default function spindleSpeakExtension(pi: ExtensionAPI): void {
  const settings = getSpeechSettings();
  if (!settings) return;

  // Daydream sessions run without a user watching; speech there would
  // arrive unprompted in the chat, so it stays blocked. Scheduler sessions
  // are allowed: a proactive reach-out is the one case
  // where unprompted speech IS the point — a voice note is a valid medium
  // for a scheduled check-in, alongside text/photo/song. `speak` still only
  // appears when it is in the session's tools: whitelist, so this enables
  // the possibility without forcing it on every scheduler session.
  const loadContext = getTelegramLoadContext();
  if (loadContext !== "main" && loadContext !== "scheduler") return;

  // Every other built-in announces itself; without this, a silent
  // registration is indistinguishable from speech being misconfigured.
  console.log(
    `[spindle-speak] registered speak tool; voice=${settings.voice ?? "(server default)"} ` +
      `model=${settings.model} endpoint=${settings.endpoint}`
  );

  const baseDescription =
    "Say something out loud in your own voice. Produces a Telegram voice " +
    "note and sends it automatically. Use it when hearing you would land " +
    "better than reading you — something warm, something long-winded, " +
    "something you would rather say than type. Not for code, links, " +
    "tables or anything the eye needs. You cannot hear the result, so " +
    "judge it by whether the words are worth saying aloud.";

  // Its own voice, stated where the agent will actually see it. Without
  // this the tool is generic and `instructions` goes unused: an agent that
  // does not know how it sounds has no basis for directing how it sounds.
  const description = settings.selfDescription
    ? `${baseDescription}\n\nYour voice: ${settings.selfDescription}`
    : baseDescription;

  pi.registerTool({
    name: "speak",
    label: "Speak",
    description,
    promptSnippet: "Say something out loud as a Telegram voice note.",
    promptGuidelines: [],
    parameters: SpeakParams,
    async execute(
      toolCallId,
      params: Static<typeof SpeakParams>,
      signal,
      _onUpdate,
      ctx
    ) {
      const text = params.text.trim();
      // The agent's own direction wins; otherwise its resting register, so
      // text that was never composed for the voice still lands in character.
      const instructions =
        params.instructions?.trim() || settings.defaultInstructions || undefined;
      if (!text) {
        return {
          content: [{ type: "text", text: "Nothing to say — `text` was empty." }],
          details: { error: "empty_text" },
        };
      }
      if (text.length > settings.maxCharacters) {
        return {
          content: [
            {
              type: "text",
              text: `That is ${text.length} characters; the cap is ${settings.maxCharacters}. A voice note that long is a monologue — say the short version, or send it as text.`,
            },
          ],
          details: { error: "too_long", length: text.length },
        };
      }

      // Rate limiting, as for a music extension. Speech invites narrating
      // everything, so the repeat guard matters more here than for songs.
      const now = Date.now();
      for (let i = recentCalls.length - 1; i >= 0; i--) {
        if (now - recentCalls[i].ts >= settings.rateLimit.windowMs) {
          recentCalls.splice(i, 1);
        }
      }
      // Keyed on text alone, deliberately — `instructions` is NOT part of
      // the key. Re-saying the same sentence with a different delivery is
      // still a repeated voice note, and reads as malfunction rather than
      // iteration. Including instructions here would let a retry loop walk
      // past maxRepeats just by varying the mood, which is precisely the
      // behaviour this guard exists to stop.
      const key = text;
      if (
        recentCalls.filter((c) => c.key === key).length >=
        settings.rateLimit.maxRepeats
      ) {
        return {
          content: [
            {
              type: "text",
              text: "You have already said that aloud. Saying it again will not land better — wait for a reply, or say something new.",
            },
          ],
          details: { error: "duplicate_text" },
        };
      }
      if (recentCalls.length >= settings.rateLimit.maxCalls) {
        const mins = Math.round(settings.rateLimit.windowMs / 60000);
        return {
          content: [
            {
              type: "text",
              text: `Rate limited: ${settings.rateLimit.maxCalls} voice notes in ${mins} minutes. Let them be heard before recording more.`,
            },
          ],
          details: { error: "rate_limited" },
        };
      }
      recentCalls.push({ ts: now, key });

      const voiceLabel = settings.voice ?? "default";
      ctx?.ui?.notify?.(`🗣️ Speaking (${voiceLabel}): "${text.slice(0, 60)}"`, "info");

      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const wavPath = join(settings.outputDir, `speak_${stamp}.wav`);
      const oggPath = join(settings.outputDir, `speak_${stamp}.ogg`);

      try {
        mkdirSync(settings.outputDir, { recursive: true });

        // Bound the request ourselves; the caller's abort signal still
        // wins if the turn is cancelled first.
        const timeout = AbortSignal.timeout(settings.timeoutMs);
        const composite = signal
          ? AbortSignal.any([signal, timeout])
          : timeout;

        // ---- streamed, when someone is listening --------------------------
        // A run opened from a channel with a live listener is heard there
        // as it is spoken; anything else is a file for later, and takes
        // the one-shot path below.
        const sm = ctx?.sessionManager as { getSessionId?: () => string } | undefined;
        const tracker = trackerFor(sm) ?? getProvenanceTracker();
        const heardLive = !!settings.streamModel && channelCapabilities(tracker?.currentRun()?.owner?.channel)?.liveAudio === true;
        const streamed = heardLive
          ? await speakStreamed({
              settings,
              text,
              instructions,
              signal: composite,
              oggPath,
              session: sm?.getSessionId?.() ?? null,
              toolCallId,
              caption: captionForUtterance(text, params.caption, settings.captionMode),
            })
          : null;
        if (streamed) console.log(`[spindle-speak] streamed ${oggPath.split("/").pop()}: first audio ${streamed.firstAudioMs}ms, ${streamed.duration.toFixed(1)}s of audio, media ${streamed.mediaId}`);

        let duration: number | undefined = streamed?.duration;
        if (!streamed) {
        // ---- synthesize -------------------------------------------------
        const body: Record<string, unknown> = {
          model: settings.model,
          input: text,
          response_format: "wav",
        };
        if (settings.voice) body.voice = settings.voice;
        // `instructions` is the OpenAI-shaped field name; audio.cpp maps it
        // to its internal `instruction` option (app/server/runtime.cpp).
        // Honoured only by models that condition on it alongside the clone
        // reference — some do, others silently ignore it, so a deployment
        // pinned to a model that ignores it will see no effect rather than
        // an error.
        if (instructions) body.instructions = instructions;

        const resp = await fetch(`${settings.endpoint}/v1/audio/speech`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: composite,
        });
        if (!resp.ok) {
          const detail = (await resp.text().catch(() => "")).slice(0, 300);
          throw new Error(
            `speech server ${resp.status} ${resp.statusText}${detail ? `: ${detail}` : ""}`
          );
        }

        const wav = Buffer.from(await resp.arrayBuffer());
        if (wav.length === 0) throw new Error("speech server returned an empty body");
        writeFileSync(wavPath, wav);
        duration = wavDurationSeconds(wav);

        // ---- transcode --------------------------------------------------
        // Telegram renders the voice-note bubble only for OGG/Opus, and
        // silently demotes anything else to a document attachment — so a
        // failure here must fail the tool, not fall back to the wav.
        await execFileAsync(
          "ffmpeg",
          [
            "-hide_banner", "-loglevel", "error", "-y",
            "-i", wavPath,
            "-c:a", "libopus", "-b:a", "32k", "-ar", "48000", "-ac", "1",
            oggPath,
          ],
          { timeout: 60_000 }
        );

        // The wav was only an ffmpeg input; keeping it doubles the disk
        // cost of every utterance for no benefit.
        try {
          unlinkSync(wavPath);
        } catch {
          /* best effort */
        }
        }

        const bytes = readFileSync(oggPath).length;

        // Durable per-utterance record. The resolved `instructions` is the
        // key field: scheduler reach-out sessions are ephemeral and persist
        // no transcript, so without this the delivery direction behind a
        // voice note is unrecoverable, which once made a slowed-voice
        // utterance impossible to explain. Append-only JSONL, one line per
        // utterance, alongside the audio in outputDir.
        try {
          appendFileSync(
            join(settings.outputDir, "speech-log.jsonl"),
            JSON.stringify({
              ts: new Date().toISOString(),
              loadContext,
              filename: oggPath.split("/").pop(),
              voice: settings.voice ?? null,
              // Whether the direction was the model's own or the resting
              // default fallback — the distinction that explains drift.
              instructionsSource: params.instructions?.trim() ? "explicit" : "default",
              instructions: instructions ?? null,
              duration,
              characters: text.length,
              text,
              ...(streamed ? { streamed: true, firstAudioMs: streamed.firstAudioMs } : {}),
            }) + "\n"
          );
        } catch {
          /* logging is best-effort; never fail an utterance over it */
        }

        ctx?.ui?.notify?.(
          `✅ Voice note ready: ${oggPath.split("/").pop()} (${Math.round(bytes / 1024)} KB)`,
          "info"
        );

        return {
          content: [
            {
              type: "text",
              text: `Said aloud${duration ? ` (${duration.toFixed(1)}s)` : ""} in your voice, and sent to Telegram as a voice note. You cannot hear it back, so judge it by whether the words were worth saying aloud rather than typing. Do not send it again by hand — it has already arrived.`,
            },
          ],
          details: {
            // filename + voice_note is the auto-send contract:
            // spindle-telegram routes this to sendVoice.
            filename: oggPath,
            duration,
            voice_note: true,
            voice: settings.voice ?? undefined,
            // Defaults to the spoken words, so the note is readable and
            // searchable in Telegram without playing it — we already know
            // exactly what was said, so making the reader press the
            // transcribe button would be withholding it on purpose.
            caption: captionForUtterance(text, params.caption, settings.captionMode),
            characters: text.length,
            fileSize: bytes,
            // Streamed speech: the note's record already exists; the delivery points at it.
            ...(streamed ? { media_id: streamed.mediaId } : {}),
          },
        };
      } catch (err) {
        // Do not hold a rate-limit slot for an utterance that never
        // reached the chat.
        const idx = recentCalls.findIndex((c) => c.ts === now && c.key === key);
        if (idx !== -1) recentCalls.splice(idx, 1);
        try {
          unlinkSync(wavPath);
        } catch {
          /* best effort */
        }

        const raw = err instanceof Error ? err.message : String(err);
        const message =
          err instanceof Error && err.name === "TimeoutError"
            ? `speech server did not respond within ${Math.round(settings.timeoutMs / 1000)}s`
            : /ENOENT/.test(raw)
            ? "ffmpeg is not installed or not on PATH — it is required to produce Telegram voice notes"
            : raw;
        return {
          content: [{ type: "text", text: `❌ Could not speak: ${message}` }],
          details: { error: message },
        };
      }
    },
  });
}

/** Test-only: clear rate-limit state between cases. */
export function resetSpeakRateLimit(): void {
  recentCalls.length = 0;
}
