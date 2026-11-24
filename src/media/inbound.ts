/**
 * How an inbound image or voice note reaches the model, shared by every
 * channel that takes one (Telegram, uploads through a workspace channel).
 *
 * The sentinel line names the file so indexing extensions and non-vision
 * tooling keep working. With native images on, the pixels ride along and an
 * affirmation line says so: its PRESENCE means the image is in context and
 * may be described directly; its ABSENCE means the file must be `read`
 * first. That moves "did I actually look?" out of the model and into an
 * auditable marker; without it an agent described images it had never read.
 */

import type { ImageContent } from "@earendil-works/pi-ai";

export const NATIVE_IMAGE_NOTE =
  "[image attached inline — the pixels are in this message; describe only what you see, do not infer from the caption or filename]";

export function imageSentinel(filename: string, caption?: string): string {
  return `[User sent an image: files/${filename}${caption ? ` with caption: "${caption}"` : ""}]`;
}

export function imagePrompt(
  filename: string,
  buffer: Buffer,
  mime: string,
  opts: { caption?: string; nativeImages: boolean },
): { prompt: string; images: ImageContent[] } {
  const sentinel = imageSentinel(filename, opts.caption);
  if (!opts.nativeImages) return { prompt: sentinel, images: [] };
  return {
    prompt: `${sentinel}\n${NATIVE_IMAGE_NOTE}`,
    images: [{ type: "image", data: buffer.toString("base64"), mimeType: mime }],
  };
}

/**
 * A voice note as the model reads it, shared by every channel that takes
 * one.
 *
 * Provenance and caveat travel with the transcript. The ASR models were
 * measured near-perfect on ordinary sentences and wrong on names — "ollama"
 * → "Alyama", "audio.cpp" → "audio. Cpp" — and a name is exactly what a
 * voice note gets sent to convey. The path is included so the clip can be
 * replayed or re-transcribed rather than argued with.
 *
 * Clients parse exactly this line: the length from `Ns, `, the file after
 * `files/`, the model after `transcribed by `, and the transcript is
 * whatever follows the line. Changing it here breaks those parsers.
 */
export function voiceSentinel(v: { filename: string; durationS?: number | null; model: string; transcript: string }): string {
  const duration = typeof v.durationS === "number" && v.durationS > 0 ? `${Math.round(v.durationS)}s, ` : "";
  return (
    `[User sent a voice note: ${duration}files/${v.filename} — transcribed by ` +
    `${v.model}, treat proper nouns as approximate and ask rather than ` +
    `act on a name that looks wrong]\n${v.transcript}`
  );
}

/**
 * The same line for a note that could not be turned into words (the ASR
 * server was down, the decode failed, or nothing was said). The user turn
 * still exists and still plays back; the model is told plainly that it has
 * the audio and not the words, so it asks instead of guessing.
 */
export function voiceSentinelUntranscribed(v: { filename: string; durationS?: number | null }): string {
  const duration = typeof v.durationS === "number" && v.durationS > 0 ? `${Math.round(v.durationS)}s, ` : "";
  return (
    `[User sent a voice note: ${duration}files/${v.filename} — not transcribed: ` +
    `the audio is saved but could not be turned into text, so you do not know what was said; ` +
    `say so and ask for it again or typed]`
  );
}
