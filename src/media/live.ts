/**
 * Audio that is still being made (streamed speech): the PCM of a voice
 * note, held in memory from its first chunk until the finished file exists.
 *
 * `speak` writes here as the speech server streams; a channel's media
 * route reads from here for a record still marked `streaming`, so a listener
 * hears the note about as it is generated instead of after. A reader always
 * starts at the first sample, whenever it arrives: a late one catches up at
 * network speed, then follows.
 *
 * Process-wide slot, like the media log, because pi can re-import extension
 * modules. Nothing is persisted: a note that was streaming when the process
 * died is simply not there, and its record is read back as not streaming.
 */

export interface LiveAudio {
  /** Samples per second of the mono signed 16-bit little-endian PCM. */
  readonly rate: number;
  write(chunk: Uint8Array): void;
  /** No more audio is coming. Readers drain what is held and finish. */
  end(): void;
  /** Every chunk from the first, then each new one as it is written, until `end()`. */
  read(): AsyncGenerator<Uint8Array, void, void>;
  readonly ended: boolean;
  readonly bytes: number;
}

class Live implements LiveAudio {
  private readonly chunks: Uint8Array[] = [];
  private waiters: Array<() => void> = [];
  ended = false;
  bytes = 0;

  constructor(readonly rate: number) {}

  write(chunk: Uint8Array): void {
    if (this.ended || chunk.length === 0) return;
    // Copied: the caller's buffer may be reused by the stream it came from.
    this.chunks.push(Uint8Array.from(chunk));
    this.bytes += chunk.length;
    this.wake();
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.wake();
  }

  private wake(): void {
    const waiting = this.waiters;
    this.waiters = [];
    for (const w of waiting) w();
  }

  async *read(): AsyncGenerator<Uint8Array, void, void> {
    let next = 0;
    for (;;) {
      while (next < this.chunks.length) yield this.chunks[next++]!;
      if (this.ended) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

interface Slot {
  live: Map<string, Live>;
}

const KEY = Symbol.for("@spindle/media-live");

function slot(): Slot {
  const g = globalThis as unknown as { [KEY]?: Slot };
  if (!g[KEY]) g[KEY] = { live: new Map() };
  return g[KEY];
}

/** Start holding a note's audio under its media id. */
export function openLiveAudio(id: string, rate: number): LiveAudio {
  const live = new Live(rate);
  slot().live.set(id, live);
  return live;
}

export function getLiveAudio(id: string): LiveAudio | undefined {
  return slot().live.get(id);
}

/** Forget a note's held audio: its file is finished, or it will never be. Ends it first, so no reader is left waiting. */
export function closeLiveAudio(id: string): void {
  const live = slot().live.get(id);
  if (!live) return;
  live.end();
  slot().live.delete(id);
}

/** `audio/pcm;rate=24000;channels=1`: what the media route calls the live form of a note, and what a client looks for. */
export function pcmContentType(rate: number): string {
  return `audio/pcm;rate=${rate};channels=1`;
}
