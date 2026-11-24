/**
 * Speech recognition — the inbound half of the audio.cpp box that `speech:`
 * already serves on the outbound half.
 *
 * One server, two directions: `speech:` turns text into a voice note via
 * POST /v1/audio/speech, this turns an inbound voice note back into text via
 * POST /v1/audio/transcriptions. Same host, same config style, separate
 * enable flags: an agent that speaks does not have to be able to read voice,
 * and vice versa.
 *
 * The server is OpenAI-shaped and takes multipart WAV only — it answers
 * anything else with `only WAV audio uploads are currently supported for
 * transcription` (audio.cpp server). So the OGG/Opus
 * Telegram delivers has to be decoded first, which is ffmpeg going the other
 * way from the one in spindle-speak. ffmpeg is already required for outbound
 * speech; nothing new is introduced here.
 *
 * Failure contract, because it is the interesting part: every failure returns
 * `null` and logs. Nothing throws, nothing is retried, and no error text is
 * ever handed to the model. A voice note that cannot be transcribed leaves
 * the original audio on disk — which is the entire reason the channel keeps
 * the file. A dropped clip is unrecoverable (Telegram file ids expire), so
 * keeping the bytes turns "silence" into "not yet" for anything that wants to
 * re-run it later, and it keeps the corpus that entity accuracy is measured
 * against. A loud failure would feel helpful for exactly one message and
 * would pollute the conversation with our own machinery.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentConfig } from "../types";

const execFileAsync = promisify(execFile);

const DEFAULT_ENDPOINT = "http://127.0.0.1:8091";
/**
 * Qwen3-ASR-0.6B on one test box: 1.4 s warm against a 23-second note, where the
 * 1.7B takes 2.1 s and Fun-ASR-Nano 5.1 s (measured, all three
 * near-identical on content). An inbound voice note is a conversation, not a
 * batch job, so the fast model that is already accurate enough wins. All of
 * them stumble on proper nouns — "ollama" came out "Alyama", "audio.cpp"
 * came out "audio. Cpp" — which is why the caller marks the transcript as
 * machine-made instead of presenting it as what was typed.
 */
const DEFAULT_MODEL = "asr-small";
/**
 * Generous, because the first call after a model is unloaded pays the load:
 * 3.2 s cold where the same model was 1.4 s warm, and a long note costs more
 * on top. A timeout this side of that just re-asks the question.
 */
const DEFAULT_TIMEOUT_MS = 60_000;
const DECODE_TIMEOUT_MS = 60_000;

export interface AsrSettings {
  /** Base URL of the audio.cpp server, no trailing slash. */
  endpoint: string;
  /** Server-side ASR model id (`models[].id`), e.g. "asr-small". */
  model: string;
  /** Request timeout in ms. */
  timeoutMs: number;
  /**
   * Whether `model` came from `asr.model` or from `DEFAULT_MODEL`. Carried
   * because the answer changes what a latency number means: a note transcribed
   * by a model nobody chose is transcribed by a constant, and after a model
   * rename or a rollback the log would otherwise keep saying "asr-small" while
   * the config said something else.
   */
  modelSource: "config" | "default";
  /**
   * Whether the transcript text belongs in the per-note log line. Default
   * true. The text already survives verbatim in the session log (it is
   * injected as the message) and in the kept clip, so this is about not
   * spreading it further than necessary, not about hiding anything — flip it
   * to false and the line keeps every other field, including the character
   * count and the empty/failed distinction.
   */
  logTranscript: boolean;
}

/**
 * How one transcription attempt ended, and where the time went. Emitted via
 * the `trace` observer exactly once per call, whatever happened, so the
 * caller can put it on one line next to the message ids it owns.
 *
 * `decode_failed` vs `request_failed` vs `empty` is the distinction that was
 * missing: all three used to be an indistinguishable null, and an empty clip
 * (nobody said anything) is a different fact from a dead server.
 */
export type AsrOutcome =
  | "ok"
  | "empty"
  | "decode_failed"
  | "http_error"
  | "request_failed";

export interface AsrTrace {
  outcome: AsrOutcome;
  /** ffmpeg ogg→wav + read, ms. Null when the decode never ran or never finished. */
  decodeMs: number | null;
  /** POST /v1/audio/transcriptions + body read, ms. Null when it was never issued. */
  asrMs: number | null;
  /** HTTP status when a response arrived, else null. */
  status: number | null;
  /** Short failure detail (server text or error message), else null. */
  error: string | null;
  /**
   * The clip's length in ms, measured from the decoded 16 kHz mono 16-bit WAV
   * (44-byte header, 32 bytes per ms). Null when the decode did not finish.
   * A browser's WebM carries no duration in its container, so for a voice
   * note recorded in a browser this is the only honest source.
   */
  audioMs: number | null;
}

/**
 * Resolve `asr:` from agent.yaml. Enabled unless explicitly turned off —
 * before this existed a voice note was thrown away, so the default that
 * preserves the owner's message is the default that should need no config.
 * `asr.enabled: false` restores the old behavior exactly.
 *
 * Endpoint falls back to `speech.endpoint`: one audio.cpp box usually does
 * both jobs, and making the operator write the same URL twice only produces the
 * version where they disagree.
 */
export function resolveAsrSettings(config: AgentConfig): AsrSettings | null {
  const asr = config.asr;
  if (asr?.enabled === false) return null;

  const endpoint = (
    asr?.endpoint ??
    config.speech?.endpoint ??
    DEFAULT_ENDPOINT
  ).replace(/\/+$/, "");

  const model = asr?.model ?? DEFAULT_MODEL;
  return {
    endpoint,
    // A typo'd model id is a server-side 4xx, which lands in the ordinary
    // failure path (log, null, stay quiet) — no need to second-guess it here.
    model,
    modelSource: asr?.model != null ? "config" : "default",
    timeoutMs: asr?.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    logTranscript: asr?.log_transcript !== false,
  };
}

/**
 * Decode an audio file to the 16 kHz mono WAV the ASR models want, POST it,
 * and return the transcript — or null for any failure whatsoever.
 *
 * `audioPath` may be any container ffmpeg on this host can read (Telegram
 * sends OGG/Opus for voice notes; a bare `.ogg` from disk works too).
 *
 * `deps.trace` receives one `AsrTrace` per call — timing and the reason the
 * call ended the way it did. It is observation only: it never changes what is
 * returned, and an exception thrown by the observer is swallowed, because a
 * logger must not be the reason a voice note fails.
 */
export async function transcribeAudioFile(
  audioPath: string,
  settings: AsrSettings,
  deps: {
    /** Injectable for tests; the global one is fine in production. */
    fetchImpl?: typeof fetch;
    /** Called exactly once, after the attempt is decided. */
    trace?: (trace: AsrTrace) => void;
  } = {}
): Promise<string | null> {
  const doFetch = deps.fetchImpl ?? fetch;
  let dir: string | null = null;

  // The attempt's own record. `stage` separates a decode failure from a
  // request failure without a second try/catch: anything thrown before the
  // POST was issued is ffmpeg's, anything after is the server's or the
  // network's. Timings are wall-clock because Date.now() is what this repo
  // already uses, and a 40 ms clock skew cannot misrepresent a 1.4 s decode.
  const t0 = Date.now();
  let postAt: number | null = null;
  let decodeMs: number | null = null;
  let asrMs: number | null = null;
  let status: number | null = null;
  let audioMs: number | null = null;
  let stage: "decode" | "request" = "decode";
  // Null until something decides it. A null surviving to the finally means
  // the catch fired, and `stage` says which half it fired in.
  let outcome: AsrOutcome | null = null;
  let error: string | null = null;

  try {
    // The decoded WAV is a pipe in disguise: it is written to a temp dir
    // rather than the Telegram files directory so it never joins the corpus
    // or gets mistaken for something the agent may deliver.
    dir = await mkdtemp(join(tmpdir(), "spindle-asr-"));
    const wavPath = join(dir, "clip.wav");

    await execFileAsync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        audioPath,
        // 16 kHz mono PCM — what the models were fed when they were measured.
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        wavPath,
      ],
      { timeout: DECODE_TIMEOUT_MS }
    );

    decodeMs = Date.now() - t0;
    stage = "request";

    const wav = await readFile(wavPath);
    if (wav.length > 44) audioMs = Math.round((wav.length - 44) / 32);
    if (wav.length === 0) {
      outcome = "decode_failed";
      error = "ffmpeg produced no audio";
      console.log(`[spindle] ASR: ffmpeg produced no audio for ${audioPath}`);
      return null;
    }

    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "clip.wav");
    form.append("model", settings.model);

    postAt = Date.now();
    const resp = await doFetch(`${settings.endpoint}/v1/audio/transcriptions`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(settings.timeoutMs),
    });

    // Body read is part of the request cost, so stop the clock after it.
    const bodyText = resp.ok ? null : await resp.text().catch(() => "");
    asrMs = Date.now() - postAt;
    status = resp.status;

    if (!resp.ok) {
      // Includes the 503 the server returns when it cannot load a model
      // because memory is tight. Not our problem to fix and not worth
      // telling anyone about: the audio is on disk, so nothing is lost, and
      // the next attempt may simply work.
      const detail = (bodyText ?? "").slice(0, 200);
      outcome = "http_error";
      error = detail || `${resp.status} ${resp.statusText}`;
      console.log(
        `[spindle] ASR: ${resp.status} ${resp.statusText} from ${settings.endpoint}` +
          `${detail ? `: ${detail}` : ""} (${audioPath})`
      );
      return null;
    }

    const data: unknown = await resp.json().catch(() => null);
    const text =
      data && typeof data === "object" && typeof (data as { text?: unknown }).text === "string"
        ? (data as { text: string }).text.trim()
        : "";

    if (!text) {
      // Silence in, silence out. A caller that injected "the transcription
      // was empty" would be handing the model a message nobody sent.
      outcome = "empty";
      console.log(`[spindle] ASR: empty transcript for ${audioPath}`);
      return null;
    }

    outcome = "ok";
    return text;
  } catch (err) {
    // One catch for everything: no ffmpeg on PATH, a decode error on a
    // truncated clip, a refused connection, a timeout, a body that is not
    // JSON. Loud enough to be found in the log, quiet in the conversation.
    error = err instanceof Error ? err.message : String(err);
    console.log(
      `[spindle] ASR failed for ${audioPath}: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  } finally {
    // One record per call, including the paths that returned early. Decided
    // here rather than in the catch so the silent returns above are reported
    // too, and so a `stage` that never moved means the decode is what failed.
    const finalOutcome: AsrOutcome =
      outcome ?? (stage === "decode" ? "decode_failed" : "request_failed");
    if (finalOutcome === "request_failed" && asrMs === null && postAt !== null) {
      // The POST was issued and never answered (refused, timed out, died
      // mid-body) — that gap is the request's, and it is the number worth
      // having when someone asks why a note took nine seconds to vanish.
      asrMs = Date.now() - postAt;
    }
    try {
      deps.trace?.({
        outcome: finalOutcome,
        decodeMs,
        asrMs,
        status,
        error: error ?? (finalOutcome === "ok" ? null : `${finalOutcome} failed`),
        audioMs,
      });
    } catch {
      // A broken observer is not allowed to eat the transcript.
    }
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
