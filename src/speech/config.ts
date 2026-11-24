import { isAbsolute, join, resolve } from "path";
import type { AgentConfig } from "../types";
import type { SpeechSettings } from "./binding";

const DEFAULT_ENDPOINT = "http://127.0.0.1:8091";
const DEFAULT_MODEL = "voices";
const DEFAULT_MAX_CHARACTERS = 1200;
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_CALLS = 8;
const DEFAULT_WINDOW_MINUTES = 10;
const DEFAULT_MAX_REPEATS = 2;

/**
 * Resolve `speech:` from agent.yaml into concrete settings, or null when
 * speech is not enabled.
 *
 * Output lands under the Telegram files directory by default, because
 * auto-send resolves relative paths there and rejects anything outside it
 * — writing elsewhere would produce files the agent could generate but
 * never deliver.
 */
export function resolveSpeechSettings(
  config: AgentConfig,
  agentDir: string
): SpeechSettings | null {
  const speech = config.speech;
  if (!speech?.enabled) return null;

  const configuredFiles = config.channels?.telegram?.files_directory;
  const filesDir = configuredFiles
    ? isAbsolute(configuredFiles)
      ? configuredFiles
      : resolve(agentDir, configuredFiles)
    : join(agentDir, "files");

  const configuredOut = speech.output_directory;
  const outputDir = configuredOut
    ? isAbsolute(configuredOut)
      ? configuredOut
      : resolve(agentDir, configuredOut)
    : join(filesDir, "speech");

  const endpoint = (speech.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");

  return {
    endpoint,
    model: speech.model ?? DEFAULT_MODEL,
    // Opt-in: only stream when the agent names a streaming model entry.
    // The offline `model` above stays the fallback, so a misconfigured or
    // down streaming entry degrades to one-shot rather than failing speech.
    streamModel: speech.stream_model?.trim() || null,
    streamFramesPerEvent: speech.stream_frames_per_event ?? 24,
    streamLookaheadMargin: speech.stream_lookahead_margin ?? 12,
    voice: speech.voice ?? null,
    outputDir,
    maxCharacters: speech.max_characters ?? DEFAULT_MAX_CHARACTERS,
    timeoutMs: speech.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    // Unrecognised values fall back to the default rather than throwing:
    // a typo here should not stop the agent from speaking.
    captionMode: speech.caption_mode === "none" ? "none" : "transcript",
    selfDescription: speech.self_description?.trim() || null,
    defaultInstructions: speech.default_instructions?.trim() || null,
    rateLimit: {
      maxCalls: speech.rate_limit?.max_calls ?? DEFAULT_MAX_CALLS,
      windowMs:
        (speech.rate_limit?.window_minutes ?? DEFAULT_WINDOW_MINUTES) * 60_000,
      maxRepeats: speech.rate_limit?.max_repeats ?? DEFAULT_MAX_REPEATS,
    },
  };
}
