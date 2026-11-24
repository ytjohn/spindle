/**
 * Global binding for speech (TTS) settings.
 *
 * Same rationale as src/channels/telegram/binding.ts and
 * src/memory/binding.ts: pi's extension loader can re-import the same
 * extension module more than once per process, and a re-imported instance
 * may start with fresh module-level state. A symbol-on-globalThis slot
 * survives those re-imports.
 *
 * Bound once from createAgentSession (which is the only place that holds
 * both the parsed config and the agent directory) and read by the
 * spindle-speak extension at register time.
 */

export interface SpeechSettings {
  endpoint: string;
  model: string;
  /**
   * Opt-in streamed speech (audio.cpp entry with mode:streaming, e.g.
   * `voice-stream`). When set, a `speak` made in a run a workspace channel
   * owns asks this model for raw PCM as it is generated: the note is on
   * record, and playable through that channel's media route, from its first audio,
   * and is encoded to the usual OGG/Opus file when the stream ends. Every
   * other `speak`, and any streaming failure before audio starts, takes the
   * one-shot `model` path unchanged. Null (default): never streamed.
   */
  streamModel: string | null;
  /** audio.cpp stream_frames_per_event (bench winner: 24). */
  streamFramesPerEvent: number;
  /** audio.cpp stream_lookahead_margin (default 12). */
  streamLookaheadMargin: number;
  /** Named server-side voice preset, or null to accept the server default. */
  voice: string | null;
  /** Absolute directory generated speech is written to. */
  outputDir: string;
  maxCharacters: number;
  timeoutMs: number;
  /**
   * "transcript" (default) captions each voice note with the words spoken,
   * so it can be read and searched without playing. "none" sends it bare.
   * An explicit caption from the tool call overrides either.
   */
  captionMode: "transcript" | "none";
  /**
   * How this agent sounds, in its own terms — appended to the `speak` tool
   * description so it is in context at the moment it decides to speak.
   * Null leaves the tool generic.
   */
  selfDescription: string | null;
  /**
   * Delivery direction applied when the agent supplies none of its own —
   * its resting register. An explicit `instructions` argument replaces it.
   *
   * This exists because the reference WAV alone is a neutral read: text not
   * written for the voice lands flat unless something directs it, and an
   * agent cannot be relied on to direct every utterance. Without a default,
   * the voice only works for text deliberately composed for it.
   */
  defaultInstructions: string | null;
  rateLimit: {
    maxCalls: number;
    windowMs: number;
    maxRepeats: number;
  };
}

interface SpindleSpeechBinding {
  settings: SpeechSettings | null;
}

const BINDING_KEY = Symbol.for("@spindle/speech-binding");

type GlobalSlot = { [BINDING_KEY]?: SpindleSpeechBinding };

function slot(): SpindleSpeechBinding {
  const g = globalThis as unknown as GlobalSlot;
  if (!g[BINDING_KEY]) {
    g[BINDING_KEY] = { settings: null };
  }
  return g[BINDING_KEY];
}

export function bindSpeechSettings(settings: SpeechSettings | null): void {
  slot().settings = settings;
}

export function getSpeechSettings(): SpeechSettings | null {
  return slot().settings;
}

/** Test-only reset. */
export function resetSpeechBinding(): void {
  slot().settings = null;
}
