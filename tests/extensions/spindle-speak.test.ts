import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import spindleSpeakExtension, {
  wavDurationSeconds,
  resetSpeakRateLimit,
  captionForUtterance,
} from "../../src/extensions/spindle-speak/index";
import {
  bindSpeechSettings,
  resetSpeechBinding,
  type SpeechSettings,
} from "../../src/speech/binding";
import {
  bindTelegramLoadContext,
  resetTelegramBinding,
} from "../../src/channels/telegram/binding";
import { resolveSpeechSettings } from "../../src/speech/config";

/**
 * Tests for the spindle-speak extension — the `speak` tool that turns text
 * into a Telegram voice note.
 *
 * fetch is stubbed to return a synthetic wav; ffmpeg is real, since the
 * OGG/Opus requirement is the whole reason the transcode step exists and
 * mocking it would test nothing. Cases needing ffmpeg are skipped when it
 * is absent rather than failing, so the suite still runs on a machine
 * without it.
 */

const hasFfmpeg = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execFileSync } = require("node:child_process");
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** Minimal 16-bit mono PCM wav of `seconds` duration at 24 kHz. */
function makeWav(seconds: number, sampleRate = 24000): Buffer {
  const channels = 1;
  const bytesPerSample = 2;
  const byteRate = sampleRate * channels * bytesPerSample;
  const dataSize = Math.round(byteRate * seconds);
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(channels * bytesPerSample, 32);
  buf.writeUInt16LE(bytesPerSample * 8, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  // A quiet sine so opus has something real to encode.
  for (let i = 0; i < dataSize / 2; i++) {
    buf.writeInt16LE(Math.round(3000 * Math.sin(i / 12)), 44 + i * 2);
  }
  return buf;
}

function makePi(): {
  registerTool: ReturnType<typeof vi.fn>;
  tools: any[];
} {
  const tools: any[] = [];
  const registerTool = vi.fn((t: any) => {
    tools.push(t);
  });
  return { registerTool, tools };
}

function settings(outputDir: string, over: Partial<SpeechSettings> = {}): SpeechSettings {
  return {
    endpoint: "http://tts.test:8091",
    model: "voices",
    voice: "casey",
    outputDir,
    maxCharacters: 1200,
    timeoutMs: 5000,
    captionMode: "transcript",
    selfDescription: null,
    defaultInstructions: null,
    rateLimit: { maxCalls: 8, windowMs: 600_000, maxRepeats: 2 },
    ...over,
  };
}

function stubSpeechFetch(wav: Buffer): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => new Response(new Uint8Array(wav), { status: 200 }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("wavDurationSeconds", () => {
  it("reads duration from a standard header", () => {
    expect(wavDurationSeconds(makeWav(2))).toBeCloseTo(2, 3);
  });

  it("walks past an unexpected chunk before data", () => {
    const base = makeWav(1);
    // Splice a LIST chunk between fmt and data — a fixed-offset reader
    // would take its bytes for audio.
    const list = Buffer.alloc(8 + 4);
    list.write("LIST", 0, "ascii");
    list.writeUInt32LE(4, 4);
    const spliced = Buffer.concat([base.subarray(0, 36), list, base.subarray(36)]);
    spliced.writeUInt32LE(spliced.length - 8, 4);
    expect(wavDurationSeconds(spliced)).toBeCloseTo(1, 3);
  });

  it("reports the bytes actually present when data is truncated", () => {
    const full = makeWav(4);
    // Header still claims 4s; only ~2s arrived.
    const truncated = full.subarray(0, 44 + (full.length - 44) / 2);
    expect(wavDurationSeconds(truncated)).toBeCloseTo(2, 1);
  });

  it("returns undefined for non-wav bytes rather than throwing", () => {
    expect(wavDurationSeconds(Buffer.from("not a wav at all"))).toBeUndefined();
    expect(wavDurationSeconds(Buffer.alloc(0))).toBeUndefined();
  });
});

describe("captionForUtterance", () => {
  it("falls back to the spoken words so the note reads without playing", () => {
    expect(captionForUtterance("Hello there.", undefined, "transcript")).toBe(
      "Hello there."
    );
  });

  it("prefers an explicit caption — the model wanted something else there", () => {
    expect(captionForUtterance("Hello there.", "the link is above", "transcript")).toBe(
      "the link is above"
    );
  });

  it("treats a blank explicit caption as absent", () => {
    expect(captionForUtterance("Hello there.", "   ", "transcript")).toBe("Hello there.");
  });

  it("sends nothing in none mode, but still honours an explicit caption", () => {
    expect(captionForUtterance("Hello there.", undefined, "none")).toBeUndefined();
    expect(captionForUtterance("Hello there.", "a note", "none")).toBe("a note");
  });

  it("collapses whitespace so the caption is one clean line", () => {
    expect(captionForUtterance("Hello\n\n  there.  ", undefined, "transcript")).toBe(
      "Hello there."
    );
  });

  // Telegram rejects the entire send over 1024 chars, so a long utterance
  // must lose its tail rather than its voice note.
  it("truncates to Telegram's 1024-character caption limit", () => {
    const long = "x".repeat(1500);
    const cap = captionForUtterance(long, undefined, "transcript")!;
    expect(cap.length).toBe(1024);
    expect(cap.endsWith("…")).toBe(true);
  });

  it("leaves a caption exactly at the limit untouched", () => {
    const exact = "y".repeat(1024);
    expect(captionForUtterance(exact, undefined, "transcript")).toBe(exact);
  });
});

describe("resolveSpeechSettings", () => {
  it("returns null when speech is absent or disabled", () => {
    expect(resolveSpeechSettings({ agent: { id: "a" } } as any, "/agent")).toBeNull();
    expect(
      resolveSpeechSettings({ agent: { id: "a" }, speech: { enabled: false } } as any, "/agent")
    ).toBeNull();
  });

  it("defaults output under the telegram files directory", () => {
    const s = resolveSpeechSettings(
      { agent: { id: "a" }, speech: { enabled: true } } as any,
      "/agent"
    );
    // Auto-send resolves relative paths inside filesDir and rejects
    // anything outside it, so the default must land there.
    expect(s!.outputDir).toBe("/agent/files/speech");
  });

  it("honors a custom files_directory", () => {
    const s = resolveSpeechSettings(
      {
        agent: { id: "a" },
        speech: { enabled: true },
        channels: { telegram: { bot_token: "t", files_directory: "/data/files" } },
      } as any,
      "/agent"
    );
    expect(s!.outputDir).toBe("/data/files/speech");
  });

  it("strips a trailing slash from the endpoint", () => {
    const s = resolveSpeechSettings(
      { agent: { id: "a" }, speech: { enabled: true, endpoint: "http://x:1/" } } as any,
      "/agent"
    );
    expect(s!.endpoint).toBe("http://x:1");
  });

  it("defaults caption_mode to transcript, and accepts none", () => {
    const d = resolveSpeechSettings(
      { agent: { id: "a" }, speech: { enabled: true } } as any,
      "/agent"
    );
    expect(d!.captionMode).toBe("transcript");
    const n = resolveSpeechSettings(
      { agent: { id: "a" }, speech: { enabled: true, caption_mode: "none" } } as any,
      "/agent"
    );
    expect(n!.captionMode).toBe("none");
  });

  // A typo in this field should not stop an agent from speaking.
  it("falls back to transcript for an unrecognised caption_mode", () => {
    const s = resolveSpeechSettings(
      { agent: { id: "a" }, speech: { enabled: true, caption_mode: "wat" } } as any,
      "/agent"
    );
    expect(s!.captionMode).toBe("transcript");
  });

  it("carries voice and rate limits through", () => {
    const s = resolveSpeechSettings(
      {
        agent: { id: "a" },
        speech: {
          enabled: true,
          voice: "juno",
          rate_limit: { max_calls: 3, window_minutes: 2, max_repeats: 1 },
        },
      } as any,
      "/agent"
    );
    expect(s!.voice).toBe("juno");
    expect(s!.rateLimit).toEqual({ maxCalls: 3, windowMs: 120_000, maxRepeats: 1 });
  });
});

describe("spindle-speak extension", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "spindle-speak-"));
    resetSpeakRateLimit();
    resetSpeechBinding();
    resetTelegramBinding();
    bindTelegramLoadContext("main");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetSpeechBinding();
    resetTelegramBinding();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers nothing when speech is unbound", () => {
    const pi = makePi();
    spindleSpeakExtension(pi as any);
    expect(pi.tools).toHaveLength(0);
  });

  it("registers exactly one tool when speech is enabled", () => {
    bindSpeechSettings(settings(tmpDir));
    const pi = makePi();
    spindleSpeakExtension(pi as any);
    // One tool on purpose: Qwen3 drops out of tool-use mode as the
    // active set grows, so a replay/list suite would cost more than it
    // gives.
    expect(pi.tools.map((t) => t.name)).toEqual(["speak"]);
  });

  it("registers nothing in a daydream load context", () => {
    bindSpeechSettings(settings(tmpDir));
    bindTelegramLoadContext("daydream");
    const pi = makePi();
    spindleSpeakExtension(pi as any);
    expect(pi.tools).toHaveLength(0);
  });

  it("rejects empty text without calling the server", async () => {
    const fetchFn = stubSpeechFetch(makeWav(1));
    bindSpeechSettings(settings(tmpDir));
    const pi = makePi();
    spindleSpeakExtension(pi as any);
    const res = await pi.tools[0].execute("c1", { text: "   " });
    expect(res.details.error).toBe("empty_text");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects text over the character cap without calling the server", async () => {
    const fetchFn = stubSpeechFetch(makeWav(1));
    bindSpeechSettings(settings(tmpDir, { maxCharacters: 20 }));
    const pi = makePi();
    spindleSpeakExtension(pi as any);
    const res = await pi.tools[0].execute("c1", { text: "x".repeat(21) });
    expect(res.details.error).toBe("too_long");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  // The catch-22 this solves: text not composed for the voice lands flat
  // without direction, and an agent cannot be relied on to direct every
  // utterance. The default is its resting register.
  it("falls back to default_instructions when the agent gives none", async () => {
    const fetchFn = stubSpeechFetch(makeWav(1));
    bindSpeechSettings(settings(tmpDir, { defaultInstructions: "warm and dry" }));
    const pi = makePi();
    spindleSpeakExtension(pi as any);
    await pi.tools[0].execute("c1", { text: "hello there" });

    const sent = JSON.parse(String((fetchFn.mock.calls[0] as [string, RequestInit])[1].body));
    expect(sent.instructions).toBe("warm and dry");
  });

  it("prefers the agent's own instructions over the default", async () => {
    const fetchFn = stubSpeechFetch(makeWav(1));
    bindSpeechSettings(settings(tmpDir, { defaultInstructions: "warm and dry" }));
    const pi = makePi();
    spindleSpeakExtension(pi as any);
    await pi.tools[0].execute("c1", { text: "hello there", instructions: "furious" });

    const sent = JSON.parse(String((fetchFn.mock.calls[0] as [string, RequestInit])[1].body));
    expect(sent.instructions).toBe("furious");
  });

  // Blank is not an override; it falls through to the resting register
  // rather than sending an empty string.
  it("falls back to the default when instructions are blank", async () => {
    const fetchFn = stubSpeechFetch(makeWav(1));
    bindSpeechSettings(settings(tmpDir, { defaultInstructions: "warm and dry" }));
    const pi = makePi();
    spindleSpeakExtension(pi as any);
    await pi.tools[0].execute("c1", { text: "hello there", instructions: "  " });

    const sent = JSON.parse(String((fetchFn.mock.calls[0] as [string, RequestInit])[1].body));
    expect(sent.instructions).toBe("warm and dry");
  });

  it("leaves the tool description generic without self_description", () => {
    bindSpeechSettings(settings(tmpDir));
    const pi = makePi();
    spindleSpeakExtension(pi as any);
    expect(pi.tools[0].description).not.toContain("Your voice:");
  });

  // The description is where the agent will actually see it; a memory file it
  // has to go fetch is not in context when it decides to speak.
  it("folds self_description into the tool description", () => {
    bindSpeechSettings(
      settings(tmpDir, { selfDescription: "quick and a little husky" })
    );
    const pi = makePi();
    spindleSpeakExtension(pi as any);
    expect(pi.tools[0].description).toContain("Your voice: quick and a little husky");
  });

  it("omits instructions from the request when not given", async () => {
    const fetchFn = stubSpeechFetch(makeWav(1));
    bindSpeechSettings(settings(tmpDir));
    const pi = makePi();
    spindleSpeakExtension(pi as any);
    await pi.tools[0].execute("c1", { text: "hello there" });

    const sent = JSON.parse(String((fetchFn.mock.calls[0] as [string, RequestInit])[1].body));
    expect(sent).not.toHaveProperty("instructions");
  });

  it("forwards instructions to the server when given", async () => {
    const fetchFn = stubSpeechFetch(makeWav(1));
    bindSpeechSettings(settings(tmpDir));
    const pi = makePi();
    spindleSpeakExtension(pi as any);
    await pi.tools[0].execute("c1", {
      text: "hello there",
      instructions: "tired but happy, soft spoken",
    });

    const sent = JSON.parse(String((fetchFn.mock.calls[0] as [string, RequestInit])[1].body));
    expect(sent.instructions).toBe("tired but happy, soft spoken");
  });

  // Whitespace-only direction is no direction; sending it would override the
  // model's own neutral default with an empty string.
  it("treats blank instructions as absent", async () => {
    const fetchFn = stubSpeechFetch(makeWav(1));
    bindSpeechSettings(settings(tmpDir));
    const pi = makePi();
    spindleSpeakExtension(pi as any);
    await pi.tools[0].execute("c1", { text: "hello there", instructions: "   " });

    const sent = JSON.parse(String((fetchFn.mock.calls[0] as [string, RequestInit])[1].body));
    expect(sent).not.toHaveProperty("instructions");
  });

  // Varying the delivery must not walk past the repeat guard.
  // The first utterance has to be produced for the second to be a repeat,
  // and producing one runs ffmpeg.
  it.skipIf(!hasFfmpeg)("counts a repeat even when instructions differ", async () => {
    stubSpeechFetch(makeWav(1));
    bindSpeechSettings(settings(tmpDir, { rateLimit: { windowMs: 600000, maxCalls: 8, maxRepeats: 1 } }));
    const pi = makePi();
    spindleSpeakExtension(pi as any);
    await pi.tools[0].execute("c1", { text: "same words", instructions: "tired" });
    const res = await pi.tools[0].execute("c1", { text: "same words", instructions: "cheerful" });
    expect(res.details.error).toBe("duplicate_text");
  });

  it("posts the configured voice and model to /v1/audio/speech", async () => {
    const fetchFn = stubSpeechFetch(makeWav(1));
    bindSpeechSettings(settings(tmpDir));
    const pi = makePi();
    spindleSpeakExtension(pi as any);
    await pi.tools[0].execute("c1", { text: "hello there" });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://tts.test:8091/v1/audio/speech");
    const sent = JSON.parse(String(init.body));
    expect(sent).toMatchObject({
      model: "voices",
      voice: "casey",
      input: "hello there",
      response_format: "wav",
    });
  });

  it("omits voice when none is configured, deferring to the server default", async () => {
    const fetchFn = stubSpeechFetch(makeWav(1));
    bindSpeechSettings(settings(tmpDir, { voice: null }));
    const pi = makePi();
    spindleSpeakExtension(pi as any);
    await pi.tools[0].execute("c1", { text: "hello" });
    const sent = JSON.parse(String((fetchFn.mock.calls[0][1] as RequestInit).body));
    expect(sent.voice).toBeUndefined();
  });

  it.skipIf(!hasFfmpeg)(
    "returns the auto-send contract: ogg filename, duration, voice_note",
    async () => {
      stubSpeechFetch(makeWav(2));
      bindSpeechSettings(settings(tmpDir));
      const pi = makePi();
      spindleSpeakExtension(pi as any);
      const res = await pi.tools[0].execute("c1", { text: "hello there" });

      expect(res.details.error).toBeUndefined();
      // voice_note is what routes this to sendVoice instead of sendAudio.
      expect(res.details.voice_note).toBe(true);
      expect(res.details.filename).toMatch(/\.ogg$/);
      expect(existsSync(res.details.filename)).toBe(true);
      expect(res.details.duration).toBeCloseTo(2, 1);
      expect(res.details.voice).toBe("casey");
    }
  );

  it.skipIf(!hasFfmpeg)("deletes the intermediate wav", async () => {
    stubSpeechFetch(makeWav(1));
    bindSpeechSettings(settings(tmpDir));
    const pi = makePi();
    spindleSpeakExtension(pi as any);
    await pi.tools[0].execute("c1", { text: "hello there" });
    // The wav was only an ffmpeg input; keeping it doubles disk cost.
    expect(readdirSync(tmpDir).filter((f) => f.endsWith(".wav"))).toHaveLength(0);
    expect(readdirSync(tmpDir).filter((f) => f.endsWith(".ogg"))).toHaveLength(1);
  });

  it.skipIf(!hasFfmpeg)("passes an explicit caption through", async () => {
    stubSpeechFetch(makeWav(1));
    bindSpeechSettings(settings(tmpDir));
    const pi = makePi();
    spindleSpeakExtension(pi as any);
    const res = await pi.tools[0].execute("c1", {
      text: "hello there",
      caption: "the link is in the message above",
    });
    expect(res.details.caption).toBe("the link is in the message above");
  });

  it.skipIf(!hasFfmpeg)("captions with the transcript when none is given", async () => {
    stubSpeechFetch(makeWav(1));
    bindSpeechSettings(settings(tmpDir));
    const pi = makePi();
    spindleSpeakExtension(pi as any);
    const res = await pi.tools[0].execute("c1", { text: "hello there" });
    expect(res.details.caption).toBe("hello there");
  });

  it.skipIf(!hasFfmpeg)("sends no caption in none mode", async () => {
    stubSpeechFetch(makeWav(1));
    bindSpeechSettings(settings(tmpDir, { captionMode: "none" }));
    const pi = makePi();
    spindleSpeakExtension(pi as any);
    const res = await pi.tools[0].execute("c1", { text: "hello there" });
    expect(res.details.caption).toBeUndefined();
  });

  // A voice note that is generated but not delivered has no use case, and
  // an exposed flag is a footgun for a model told to "test the tool".
  it("exposes no suppress_auto_send parameter", () => {
    bindSpeechSettings(settings(tmpDir));
    const pi = makePi();
    spindleSpeakExtension(pi as any);
    expect(Object.keys(pi.tools[0].parameters.properties)).toEqual([
      "text",
      "caption",
      "instructions",
    ]);
  });

  it.skipIf(!hasFfmpeg)("never sets suppress_auto_send in its result", async () => {
    stubSpeechFetch(makeWav(1));
    bindSpeechSettings(settings(tmpDir));
    const pi = makePi();
    spindleSpeakExtension(pi as any);
    const res = await pi.tools[0].execute("c1", { text: "hello there" });
    expect(res.details.suppress_auto_send).toBeUndefined();
  });

  it("surfaces a server error instead of producing a file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("model not loaded", { status: 503 }))
    );
    bindSpeechSettings(settings(tmpDir));
    const pi = makePi();
    spindleSpeakExtension(pi as any);
    const res = await pi.tools[0].execute("c1", { text: "hello there" });
    expect(res.details.error).toMatch(/503/);
    expect(readdirSync(tmpDir)).toHaveLength(0);
  });

  it("treats an empty response body as a failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array(0), { status: 200 }))
    );
    bindSpeechSettings(settings(tmpDir));
    const pi = makePi();
    spindleSpeakExtension(pi as any);
    const res = await pi.tools[0].execute("c1", { text: "hello there" });
    expect(res.details.error).toMatch(/empty body/);
  });

  // Both rate-limit cases need the earlier calls to actually succeed so
  // they occupy a slot, which means a real transcode.
  it.skipIf(!hasFfmpeg)("blocks a repeated utterance", async () => {
    stubSpeechFetch(makeWav(1));
    bindSpeechSettings(
      settings(tmpDir, { rateLimit: { maxCalls: 8, windowMs: 600_000, maxRepeats: 1 } })
    );
    const pi = makePi();
    spindleSpeakExtension(pi as any);
    await pi.tools[0].execute("c1", { text: "same thing" });
    const res = await pi.tools[0].execute("c2", { text: "same thing" });
    expect(res.details.error).toBe("duplicate_text");
  });

  it.skipIf(!hasFfmpeg)("blocks once the call cap is reached", async () => {
    stubSpeechFetch(makeWav(1));
    bindSpeechSettings(
      settings(tmpDir, { rateLimit: { maxCalls: 2, windowMs: 600_000, maxRepeats: 5 } })
    );
    const pi = makePi();
    spindleSpeakExtension(pi as any);
    await pi.tools[0].execute("c1", { text: "one" });
    await pi.tools[0].execute("c2", { text: "two" });
    const res = await pi.tools[0].execute("c3", { text: "three" });
    expect(res.details.error).toBe("rate_limited");
  });

  it("does not consume a rate-limit slot when synthesis fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 }))
    );
    bindSpeechSettings(
      settings(tmpDir, { rateLimit: { maxCalls: 1, windowMs: 600_000, maxRepeats: 5 } })
    );
    const pi = makePi();
    spindleSpeakExtension(pi as any);
    const first = await pi.tools[0].execute("c1", { text: "one" });
    expect(first.details.error).toMatch(/500/);
    // A failed utterance never reached the chat, so it must not burn the
    // single available slot.
    const second = await pi.tools[0].execute("c2", { text: "two" });
    expect(second.details.error).not.toBe("rate_limited");
  });
});
