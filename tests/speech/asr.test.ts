import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveAsrSettings,
  transcribeAudioFile,
  type AsrSettings,
  type AsrTrace,
} from "../../src/speech/asr";
import type { AgentConfig } from "../../src/types";
import { hasFfmpeg, startStubAsr, toneWav } from "../fixtures/asr-stub-server";

function cfg(partial: Record<string, unknown>): AgentConfig {
  return partial as unknown as AgentConfig;
}

describe("resolveAsrSettings", () => {
  it("is ON with no asr: block at all — voice notes used to be discarded", () => {
    const settings = resolveAsrSettings(cfg({ agent: { id: "juno" } }));
    expect(settings).not.toBeNull();
    expect(settings!.model).toBe("asr-small");
    expect(settings!.endpoint).toBe("http://127.0.0.1:8091");
    expect(settings!.timeoutMs).toBe(60_000);
  });

  it("is the kill switch: enabled false yields null and nothing else consults ASR", () => {
    expect(resolveAsrSettings(cfg({ asr: { enabled: false } }))).toBeNull();
  });

  it("inherits the speech endpoint — one audio.cpp box usually does both directions", () => {
    const settings = resolveAsrSettings(
      cfg({ speech: { endpoint: "http://speech.example:8091/" } })
    );
    // Trailing slash stripped, so callers can append the path plainly.
    expect(settings!.endpoint).toBe("http://speech.example:8091");
  });

  it("asr.endpoint wins over speech.endpoint; model and timeout are config, not constants", () => {
    const settings = resolveAsrSettings(
      cfg({
        speech: { endpoint: "http://tts.internal:8091" },
        asr: { endpoint: "http://asr.internal:8092", model: "asr", timeout_ms: 5000 },
      })
    );
    expect(settings!.endpoint).toBe("http://asr.internal:8092");
    expect(settings!.model).toBe("asr");
    expect(settings!.timeoutMs).toBe(5000);
  });

  it("says whether the model was chosen or is the constant — a latency number needs a referent", () => {
    expect(resolveAsrSettings(cfg({ agent: { id: "juno" } }))!.modelSource).toBe("default");
    expect(resolveAsrSettings(cfg({ asr: { model: "asr-fun" } }))!.modelSource).toBe("config");
    // An explicit null is not a choice; it falls back like an absent key.
    expect(resolveAsrSettings(cfg({ asr: { model: null } }))!.modelSource).toBe("default");
  });

  it("logs the transcript unless told not to", () => {
    expect(resolveAsrSettings(cfg({ agent: { id: "juno" } }))!.logTranscript).toBe(true);
    expect(resolveAsrSettings(cfg({ asr: { log_transcript: false } }))!.logTranscript).toBe(false);
  });
});

const ffmpegReady = hasFfmpeg();

describe.skipIf(!ffmpegReady)("transcribeAudioFile (ffmpeg + transcription endpoint)", () => {
  let dir: string;
  let clip: string;
  let closeStub: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "asr-test-"));
    clip = join(dir, "voice.ogg");
    await writeFile(clip, toneWav());
    closeStub = null;
  });

  afterEach(async () => {
    await closeStub?.();
    await rm(dir, { recursive: true, force: true });
  });

  function settings(endpoint: string, model = "asr-small"): AsrSettings {
    return {
      endpoint,
      model,
      timeoutMs: 10_000,
      modelSource: "config",
      logTranscript: true,
    };
  }

  it("traces the successful call: outcome, both halves of the time, nothing else", async () => {
    const stub = await startStubAsr(() => ({ status: 200, body: { text: "hello there" } }));
    closeStub = stub.close;

    const traces: AsrTrace[] = [];
    const text = await transcribeAudioFile(clip, settings(stub.endpoint), {
      trace: (t) => traces.push(t),
    });

    expect(text).toBe("hello there");
    // Exactly one record per call — the caller writes one line per note, and
    // a second trace would either double it or have to be filtered out.
    expect(traces).toHaveLength(1);
    expect(traces[0].outcome).toBe("ok");
    expect(traces[0].status).toBe(200);
    expect(traces[0].error).toBeNull();
    expect(traces[0].decodeMs).toBeTypeOf("number");
    expect(traces[0].asrMs).toBeTypeOf("number");
  });

  it("empty comes back as empty, not as a failure — the distinction that was missing", async () => {
    const stub = await startStubAsr(() => ({ status: 200, body: { text: "   " } }));
    closeStub = stub.close;

    const traces: AsrTrace[] = [];
    await transcribeAudioFile(clip, settings(stub.endpoint), { trace: (t) => traces.push(t) });

    expect(traces[0].outcome).toBe("empty");
    expect(traces[0].status).toBe(200);
    // The clip did reach the server, so both halves have a number.
    expect(traces[0].asrMs).toBeTypeOf("number");
    expect(traces[0].decodeMs).toBeTypeOf("number");
  });

  it("a 503 traces as http_error with the server's own words", async () => {
    const stub = await startStubAsr(() => ({
      status: 503,
      body: { error: { message: "no memory to load model" } },
    }));
    closeStub = stub.close;

    const traces: AsrTrace[] = [];
    await transcribeAudioFile(clip, settings(stub.endpoint), { trace: (t) => traces.push(t) });

    expect(traces[0].outcome).toBe("http_error");
    expect(traces[0].status).toBe(503);
    expect(traces[0].error).toContain("no memory to load model");
  });

  it("nothing listening traces as request_failed, and the dead time is still counted", async () => {
    const traces: AsrTrace[] = [];
    await transcribeAudioFile(clip, settings("http://127.0.0.1:1"), {
      trace: (t) => traces.push(t),
    });

    expect(traces[0].outcome).toBe("request_failed");
    expect(traces[0].status).toBeNull();
    // The decode succeeded and the POST was issued, so both are numbers: a
    // note that vanished after three seconds should not look instantaneous.
    expect(traces[0].decodeMs).toBeTypeOf("number");
    expect(traces[0].asrMs).toBeTypeOf("number");
    expect(traces[0].error).toBeTruthy();
  });

  it("ffmpeg failing traces as decode_failed with no request time at all", async () => {
    const junk = join(dir, "rubbish.ogg");
    await writeFile(junk, Buffer.from("this is not audio"));
    const stub = await startStubAsr(() => ({ status: 200, body: { text: "x" } }));
    closeStub = stub.close;

    const traces: AsrTrace[] = [];
    await transcribeAudioFile(junk, settings(stub.endpoint), { trace: (t) => traces.push(t) });

    expect(traces[0].outcome).toBe("decode_failed");
    expect(traces[0].asrMs).toBeNull();
    expect(stub.requests).toHaveLength(0);
  });

  it("a trace observer that throws cannot eat the transcript", async () => {
    const stub = await startStubAsr(() => ({ status: 200, body: { text: "still here" } }));
    closeStub = stub.close;

    const text = await transcribeAudioFile(clip, settings(stub.endpoint), {
      trace: () => {
        throw new Error("observer exploded");
      },
    });
    expect(text).toBe("still here");
  });

  it("uploads WAV (not the OGG it was given) with the configured model, returns the text", async () => {
    const stub = await startStubAsr(() => ({ status: 200, body: { text: "pick up the mail" } }));
    closeStub = stub.close;

    const text = await transcribeAudioFile(clip, settings(stub.endpoint, "asr-fun"));

    expect(text).toBe("pick up the mail");
    expect(stub.requests).toHaveLength(1);
    const sent = stub.requests[0].body;
    // The server rejects anything but WAV with a 400, so what went on the
    // wire matters more than the file we started from. It travels inside a
    // multipart body, so the magic is somewhere past the part headers.
    const payload = sent.toString("latin1");
    const riff = sent.indexOf(Buffer.from("RIFF"));
    expect(riff).toBeGreaterThan(-1);
    expect(sent.subarray(riff + 8, riff + 12).toString()).toBe("WAVE");
    expect(payload).toContain('filename="clip.wav"');
    expect(payload).toContain('name="model"');
    expect(payload).toContain("asr-fun");
    expect(stub.requests[0].contentType).toContain("multipart/form-data");
  });

  it("trims the transcript and treats whitespace-only as no transcript", async () => {
    const stub = await startStubAsr(() => ({ status: 200, body: { text: "   \n " } }));
    closeStub = stub.close;
    expect(await transcribeAudioFile(clip, settings(stub.endpoint))).toBeNull();
  });

  it("a 503 (server declined to load the model) is a quiet null, not a thrown error", async () => {
    const stub = await startStubAsr(() => ({
      status: 503,
      body: { error: { message: "no memory to load model" } },
    }));
    closeStub = stub.close;
    expect(await transcribeAudioFile(clip, settings(stub.endpoint))).toBeNull();
  });

  it("nothing listening is a quiet null", async () => {
    expect(
      await transcribeAudioFile(clip, settings("http://127.0.0.1:1"))
    ).toBeNull();
  });

  it("a body that is not JSON is a quiet null", async () => {
    const stub = await startStubAsr(() => ({ status: 200, body: "not-json" }));
    closeStub = stub.close;
    // JSON.stringify makes that a valid JSON *string*, which has no .text.
    expect(await transcribeAudioFile(clip, settings(stub.endpoint))).toBeNull();
  });

  it("a file that is not audio is a quiet null (ffmpeg fails, we do not)", async () => {
    const junk = join(dir, "not-a-voice.ogg");
    await writeFile(junk, Buffer.from("this is not audio"));
    const stub = await startStubAsr(() => ({ status: 200, body: { text: "x" } }));
    closeStub = stub.close;
    expect(await transcribeAudioFile(junk, settings(stub.endpoint))).toBeNull();
    expect(stub.requests).toHaveLength(0);
  });
});
