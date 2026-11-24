import { describe, expect, it } from "vitest";
import { closeLiveAudio, getLiveAudio, openLiveAudio, pcmContentType } from "../../src/media/live";

async function collect(gen: AsyncGenerator<Uint8Array>): Promise<number[]> {
  const out: number[] = [];
  for await (const c of gen) out.push(...c);
  return out;
}

describe("live audio (streamed speech)", () => {
  it("a reader gets every chunk from the first, then each new one, until the end", async () => {
    const live = openLiveAudio("md_a", 24000);
    live.write(new Uint8Array([1, 2]));
    const early = collect(live.read());
    await Promise.resolve();
    live.write(new Uint8Array([3]));
    // A late reader starts at the first sample too.
    const late = collect(getLiveAudio("md_a")!.read());
    live.write(new Uint8Array([4, 5]));
    live.end();
    expect(await early).toEqual([1, 2, 3, 4, 5]);
    expect(await late).toEqual([1, 2, 3, 4, 5]);
    expect(live.bytes).toBe(5);
    closeLiveAudio("md_a");
  });

  it("keeps its own copy of a chunk, and ignores writes after the end", async () => {
    const live = openLiveAudio("md_b", 24000);
    const buf = new Uint8Array([7, 8]);
    live.write(buf);
    buf[0] = 0;
    live.end();
    live.write(new Uint8Array([9]));
    expect(await collect(live.read())).toEqual([7, 8]);
    closeLiveAudio("md_b");
  });

  it("closing ends a waiting reader and forgets the note", async () => {
    const live = openLiveAudio("md_c", 24000);
    const waiting = collect(live.read());
    closeLiveAudio("md_c");
    expect(await waiting).toEqual([]);
    expect(getLiveAudio("md_c")).toBeUndefined();
  });

  it("names its form so a client can tell it from a file", () => {
    expect(pcmContentType(24000)).toBe("audio/pcm;rate=24000;channels=1");
  });
});
