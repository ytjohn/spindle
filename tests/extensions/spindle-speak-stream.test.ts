import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { speakStreamed, STREAM_RATE } from "../../src/extensions/spindle-speak/index";
import { MediaLog, bindMediaLog, type DeliveredMedia } from "../../src/media/log";
import { getLiveAudio } from "../../src/media/live";

const settings = { endpoint: "http://speech", voice: "juno", streamModel: "voice-stream", streamFramesPerEvent: 24, streamLookaheadMargin: 12 };

/** A speech server that sends the chunks one at a time, each when `step()` is called. */
function server(chunks: Uint8Array[], opts: { status?: number; failAfter?: number } = {}) {
  let release: Array<() => void> = [];
  const requests: any[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    if (opts.status && opts.status !== 200) return new Response("speech streaming requires a model configured with mode=streaming", { status: opts.status });
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (opts.failAfter !== undefined && i >= opts.failAfter) return c.error(new Error("connection reset"));
        if (i >= chunks.length) return c.close();
        await new Promise<void>((r) => release.push(r));
        c.enqueue(chunks[i++]!);
      },
    });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  const step = async () => {
    for (let n = 0; n < 50 && release.length === 0; n++) await new Promise((r) => setTimeout(r, 2));
    const r = release; release = []; for (const f of r) f();
    await new Promise((r) => setTimeout(r, 5));
  };
  return { fetchImpl, step, requests };
}

describe("speakStreamed", () => {
  let dir: string; let log: MediaLog; let seen: DeliveredMedia[];
  const encode = async (pcm: string, ogg: string) => writeFileSync(ogg, Buffer.concat([Buffer.from("OggS"), readFileSync(pcm)]));
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "speak-stream-"));
    log = new MediaLog(join(dir, "media-log.jsonl"));
    bindMediaLog(log);
    seen = [];
    log.subscribe((m) => seen.push({ ...m }));
  });
  afterEach(() => bindMediaLog(null));

  const run = (s: ReturnType<typeof server>, extra: Partial<Parameters<typeof speakStreamed>[0]> = {}) =>
    speakStreamed({ settings, text: "hello there", instructions: "warm", signal: new AbortController().signal, oggPath: join(dir, "speak_x.ogg"), session: "sess", toolCallId: "call_1", caption: "hello there", fetchImpl: s.fetchImpl, encode, ...extra });

  it("the note is on record and readable from its first audio, and becomes an ordinary file at the end", async () => {
    const s = server([new Uint8Array(4800), new Uint8Array(4800), new Uint8Array(2400)]);
    const p = run(s);
    await s.step();
    // First chunk in: recorded as streaming, nothing on disk yet, audio held.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: "voice", mime: "audio/ogg", streaming: true, session: "sess", toolCallId: "call_1", via: "telegram", caption: "hello there", bytes: 0 });
    const id = seen[0]!.id;
    expect(existsSync(join(dir, "speak_x.ogg"))).toBe(false);
    const live = getLiveAudio(id)!;
    expect(live.bytes).toBe(4800);
    const heard = (async () => { let n = 0; for await (const c of live.read()) n += c.length; return n; })();
    await s.step(); await s.step(); await s.step();
    const out = await p;
    expect(out).toMatchObject({ mediaId: id, duration: 12000 / 2 / STREAM_RATE });
    expect(await heard).toBe(12000);
    // Same id, no longer streaming, with its size and length; the held audio is gone.
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ id, bytes: 12004, durationMs: 250 });
    expect(seen[1]!.streaming).toBeUndefined();
    expect(getLiveAudio(id)).toBeUndefined();
    expect(readFileSync(join(dir, "speak_x.ogg")).subarray(0, 4).toString()).toBe("OggS");
    expect(existsSync(join(dir, "speak_x.pcm"))).toBe(false);
    // Reloaded from disk: one record for the note, the finished one.
    const again = new MediaLog(join(dir, "media-log.jsonl"));
    expect(again.forSession("sess")).toHaveLength(1);
    expect(again.get(id)).toMatchObject({ bytes: 12004 });
    // What was asked of the server.
    expect(s.requests[0]).toMatchObject({ model: "voice-stream", voice: "juno", instructions: "warm", stream: true, stream_format: "audio", response_format: "pcm", options: { stream_frames_per_event: "24", stream_lookahead_margin: "12" } });
  });

  it("a server with no streaming model costs nothing: null, no record, the one-shot path is taken", async () => {
    const s = server([], { status: 500 });
    expect(await run(s)).toBeNull();
    expect(seen).toEqual([]);
  });

  it("no streaming model configured, or no media log: not attempted", async () => {
    const s = server([new Uint8Array(10)]);
    expect(await run(s, { settings: { ...settings, streamModel: null } })).toBeNull();
    bindMediaLog(null);
    expect(await run(s)).toBeNull();
    expect(s.requests).toEqual([]);
  });

  it("a fault after audio began throws, and the note is left neither streaming nor held", async () => {
    const s = server([new Uint8Array(4800), new Uint8Array(4800)], { failAfter: 1 });
    const p = run(s);
    p.catch(() => {});
    await s.step(); await s.step();
    await expect(p).rejects.toThrow("connection reset");
    expect(seen).toHaveLength(2);
    expect(seen[1]!.streaming).toBeUndefined();
    expect(getLiveAudio(seen[0]!.id)).toBeUndefined();
  });

  it("a record that was streaming when the process died is read back as not streaming", () => {
    writeFileSync(join(dir, "dead.jsonl"), JSON.stringify({ id: "md_dead", at: "2026-11-16T00:00:00Z", session: "s", type: "voice", mime: "audio/ogg", path: "/nowhere.ogg", bytes: 0, via: "telegram", streaming: true }) + "\n");
    expect(new MediaLog(join(dir, "dead.jsonl")).get("md_dead")!.streaming).toBeUndefined();
  });
});
