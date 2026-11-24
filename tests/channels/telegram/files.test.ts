import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { dispatchFile } from "../../../src/channels/telegram/files";
import { bindMediaLog, MediaLog } from "../../../src/media/log";
import type { TelegramApi } from "../../../src/channels/telegram/api";
import type { TelegramMessage } from "../../../src/channels/telegram/types";
import type { AsrSettings } from "../../../src/speech/asr";
import { hasFfmpeg, startStubAsr, toneWav } from "../../fixtures/asr-stub-server";

// A minimal fake TelegramApi: getFile returns a path, downloadFile returns
// a fixed buffer. Only the two methods handlePhoto touches are implemented.
function fakeApi(bytes: Buffer, filePath = "photos/file_1.jpg"): TelegramApi {
  return {
    getFile: async (_fileId: string) => ({ file_id: _fileId, file_unique_id: "u1", file_path: filePath }),
    downloadFile: async (_path: string) => bytes,
  } as unknown as TelegramApi;
}

function photoMessage(caption?: string): TelegramMessage {
  return {
    message_id: 8806,
    from: { id: 42, is_bot: false, username: "tester" },
    chat: { id: 99, type: "private" },
    date: 0,
    photo: [
      { file_id: "small", file_unique_id: "sm", width: 90, height: 90, file_size: 1000 },
      { file_id: "large", file_unique_id: "AQADuwxrG6i2CUZ9", width: 1280, height: 1280, file_size: 50000 },
    ],
    ...(caption ? { caption } : {}),
  } as unknown as TelegramMessage;
}

describe("dispatchFile — photo handling", () => {
  let filesDir: string;
  const bytes = Buffer.from("fake-jpeg-bytes");

  beforeEach(() => {
    filesDir = mkdtempSync(join(tmpdir(), "spindle-files-"));
  });
  afterEach(() => {
    rmSync(filesDir, { recursive: true, force: true });
  });

  it("default (nativeImages=false): returns a text sentinel string, saves the file", async () => {
    const result = await dispatchFile(photoMessage("How to get in the web"), fakeApi(bytes), filesDir);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("photo");
    // Sentinel is a bare string on the legacy path
    expect(typeof result!.prompt).toBe("string");
    const prompt = result!.prompt as string;
    expect(prompt).toContain("[User sent an image: files/tg-8806-AQADuwxrG6i2CUZ9.jpg");
    expect(prompt).toContain('with caption: "How to get in the web"');
    // File written to disk
    const saved = join(filesDir, "tg-8806-AQADuwxrG6i2CUZ9.jpg");
    expect(existsSync(saved)).toBe(true);
    expect(readFileSync(saved).equals(bytes)).toBe(true);
  });

  it("nativeImages=true: returns prompt + native ImageContent with base64 + mimeType", async () => {
    const result = await dispatchFile(photoMessage("look"), fakeApi(bytes), filesDir, true);
    expect(result).not.toBeNull();
    const prompt = result!.prompt;
    // Rich object on the native path
    expect(typeof prompt).toBe("object");
    expect(prompt).not.toBeNull();
    const rich = prompt as { prompt: string; images: Array<{ type: string; data: string; mimeType: string }> };
    // Sentinel text preserved for indexing extensions
    expect(rich.prompt).toContain("[User sent an image: files/tg-8806-AQADuwxrG6i2CUZ9.jpg");
    // Affirmation marker present — the observable "pixels are attached" seam
    expect(rich.prompt).toContain("image attached inline");
    expect(rich.prompt).toContain("describe only what you see");
    // Native image attached
    expect(rich.images).toHaveLength(1);
    expect(rich.images[0].type).toBe("image");
    expect(rich.images[0].mimeType).toBe("image/jpeg");
    expect(rich.images[0].data).toBe(bytes.toString("base64"));
  });

  it("legacy path has NO affirmation marker (absence is the seam)", async () => {
    const result = await dispatchFile(photoMessage("x"), fakeApi(bytes), filesDir, false);
    expect(typeof result!.prompt).toBe("string");
    expect(result!.prompt as string).not.toContain("image attached inline");
  });

  it("derives mimeType from the downloaded file extension (png)", async () => {
    const png = Buffer.from("fake-png");
    const result = await dispatchFile(photoMessage(), fakeApi(png, "photos/file_1.png"), filesDir, true);
    const rich = result!.prompt as { images: Array<{ mimeType: string }> };
    expect(rich.images[0].mimeType).toBe("image/png");
  });

  it("picks the largest photo size by file_size", async () => {
    const result = await dispatchFile(photoMessage(), fakeApi(bytes), filesDir);
    // largest has file_unique_id AQADuwxrG6i2CUZ9
    expect(result!.prompt as string).toContain("AQADuwxrG6i2CUZ9");
  });

  it("with a media log, the photo is registered inbound and its ref rides in the sentinel", async () => {
    const log = new MediaLog(join(filesDir, "media-log.jsonl"));
    bindMediaLog(log);
    try {
      const result = await dispatchFile(photoMessage("from earlier"), fakeApi(bytes), filesDir);
      const prompt = result!.prompt as string;
      const m = prompt.match(/files\/tg-8806-(md_[0-9a-f]{12})\.jpg/);
      expect(m).not.toBeNull();
      const rec = log.get(m![1]!);
      expect(rec).toMatchObject({ type: "image", mime: "image/jpeg", via: "telegram", inbound: true, caption: "from earlier", session: null });
      expect(existsSync(rec!.path)).toBe(true);
    } finally {
      bindMediaLog(null);
    }
  });

  it("returns null for a text-only message (no file)", async () => {
    const msg = { message_id: 1, from: { id: 42 }, chat: { id: 99 }, text: "hi" } as unknown as TelegramMessage;
    const result = await dispatchFile(msg, fakeApi(bytes), filesDir, true);
    expect(result).toBeNull();
  });
});

function voiceMessage(): TelegramMessage {
  return {
    message_id: 9001,
    from: { id: 42, is_bot: false, username: "tester" },
    chat: { id: 99, type: "private" },
    date: 0,
    voice: { file_id: "voice_1", file_unique_id: "VjVxYz9", duration: 7, mime_type: "audio/ogg" },
  } as unknown as TelegramMessage;
}

function asr(endpoint: string): AsrSettings {
  return {
    endpoint,
    model: "asr-small",
    timeoutMs: 10_000,
    modelSource: "config",
    logTranscript: true,
  };
}

/**
 * Captures the journal. The line is the product of this handler half — the
 * run has to be findable afterwards — so it is asserted like an interface,
 * not eyeballed in stdout.
 */
function captureLog(): () => string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return () => {
    console.log = original;
    return lines.filter((l) => l.includes("[spindle] voice "));
  };
}

const VOICE_FILE = "tg-9001-VjVxYz9.ogg";
const ffmpegReady = hasFfmpeg();

describe("dispatchFile — voice handling", () => {
  let filesDir: string;
  let closeStub: (() => Promise<void>) | null = null;
  // ffmpeg reads by content, so a WAV standing in for the OGG decodes fine.
  const api = fakeApi(toneWav(), "files/voice_1.ogg");

  beforeEach(() => {
    filesDir = mkdtempSync(join(tmpdir(), "spindle-voice-"));
    closeStub = null;
  });
  afterEach(async () => {
    await closeStub?.();
    rmSync(filesDir, { recursive: true, force: true });
  });

  it("ASR off (asr=null): the audio is still kept, and the kind is reported unsupported", async () => {
    const result = await dispatchFile(voiceMessage(), api, filesDir, false, null);

    expect(result!.kind).toBe("voice");
    // null, not { drop: "silent" } — with the feature off this is genuinely
    // "not handled", so the sender gets the channel's polite reply, exactly
    // as before voice support existed.
    expect(result!.prompt).toBeNull();
    expect(existsSync(join(filesDir, VOICE_FILE))).toBe(true);
  });

  it.skipIf(!ffmpegReady)("transcribes and delivers the words as the message text", async () => {
    const stub = await startStubAsr(() => ({
      status: 200,
      body: { text: "Are we still doing the trail on Saturday?" },
    }));
    closeStub = stub.close;

    const result = await dispatchFile(voiceMessage(), api, filesDir, false, asr(stub.endpoint));

    const prompt = result!.prompt as string;
    expect(typeof prompt).toBe("string");
    expect(prompt).toContain("Are we still doing the trail on Saturday?");
    // Provenance: that it was a voice note, where the clip lives, which model
    // produced the words, and that names in them are approximate.
    expect(prompt).toContain("[User sent a voice note:");
    expect(prompt).toContain(`files/${VOICE_FILE}`);
    expect(prompt).toContain("7s");
    expect(prompt).toContain("asr-small");
    expect(prompt).toContain("proper nouns");
    // The original audio is kept: a discarded clip cannot be re-transcribed
    // later, and this is the corpus entity accuracy is measured against.
    expect(existsSync(join(filesDir, VOICE_FILE))).toBe(true);
  });

  it.skipIf(!ffmpegReady)("empty transcript drops silently — no invented message", async () => {
    const stub = await startStubAsr(() => ({ status: 200, body: { text: "" } }));
    closeStub = stub.close;

    const result = await dispatchFile(voiceMessage(), api, filesDir, false, asr(stub.endpoint));

    expect(result!.prompt).toEqual({ drop: "silent" });
    expect(existsSync(join(filesDir, VOICE_FILE))).toBe(true);
  });

  it.skipIf(!ffmpegReady)(
    "a successful run leaves exactly one journal line, with the ids, the model and both latencies",
    async () => {
      const stub = await startStubAsr(() => ({
        status: 200,
        body: { text: "Call Henderson about the $2,681" },
      }));
      closeStub = stub.close;
      const readLog = captureLog();

      await dispatchFile(voiceMessage(), api, filesDir, false, asr(stub.endpoint));
      const voice = readLog();

      expect(voice).toHaveLength(1);
      const line = voice[0];
      // Recoverability: without msg/file_id/file_unique_id the note is gone
      // forever, which is exactly how four notes were once lost.
      expect(line).toContain("msg=9001");
      expect(line).toContain("file_id=voice_1");
      expect(line).toContain("unique=VjVxYz9");
      expect(line).toContain(`clip=files/${VOICE_FILE}`);
      expect(line).toMatch(/bytes=\d+/);
      expect(line).toContain("dur_s=7");
      expect(line).toContain("outcome=ok");
      // Which model, and whether anyone chose it.
      expect(line).toContain("model=asr-small");
      expect(line).toContain("model_source=config");
      // The split that makes the warm baselines comparable.
      expect(line).toMatch(/decode_ms=\d+/);
      expect(line).toMatch(/asr_ms=\d+/);
      expect(line).toMatch(/wall_ms=\d+/);
      // And the words, so a silent substitution ("ollama" → "Alyama") is
      // findable later rather than only believable at the time.
      expect(line).toContain('transcript="Call Henderson about the $2,681"');
      expect(line).toMatch(/chars=\d+/);
      expect(line.split("\n")).toHaveLength(1);
    }
  );

  it.skipIf(!ffmpegReady)(
    "empty and failed are distinguishable afterwards — that was the point",
    async () => {
      const emptyStub = await startStubAsr(() => ({ status: 200, body: { text: "" } }));
      closeStub = emptyStub.close;
      let readLog = captureLog();
      await dispatchFile(voiceMessage(), api, filesDir, false, asr(emptyStub.endpoint));
      const emptyLine = readLog()[0];
      expect(emptyLine).toContain("outcome=empty");
      expect(emptyLine).toContain("chars=0");
      expect(emptyLine).not.toContain("transcript=");

      const deadStub = await startStubAsr(() => ({ status: 503, body: { o: 1 } }));
      closeStub = deadStub.close;
      readLog = captureLog();
      await dispatchFile(voiceMessage(), api, filesDir, false, asr(deadStub.endpoint));
      const failedLine = readLog()[0];
      expect(failedLine).toContain("outcome=http_error");
      expect(failedLine).toContain("error=");
      // Still one line per note, whatever the outcome.
      expect(readLog()).toHaveLength(1);
    }
  );

  it.skipIf(!ffmpegReady)(
    "asr.log_transcript: false keeps every field but the words",
    async () => {
      const stub = await startStubAsr(() => ({ status: 200, body: { text: "private words" } }));
      closeStub = stub.close;
      const readLog = captureLog();

      await dispatchFile(
        voiceMessage(),
        api,
        filesDir,
        false,
        { ...asr(stub.endpoint), logTranscript: false }
      );
      const line = readLog()[0];

      expect(line).toContain("outcome=ok");
      expect(line).toMatch(/chars=13/);
      expect(line).not.toContain("private words");
    }
  );

  it.skipIf(!ffmpegReady)(
    "a long transcript is previewed like inbound text (77 chars + ...), full length in chars=",
    async () => {
      const words = "x".repeat(300);
      const stub = await startStubAsr(() => ({ status: 200, body: { text: words } }));
      closeStub = stub.close;
      const readLog = captureLog();

      await dispatchFile(voiceMessage(), api, filesDir, false, asr(stub.endpoint));
      const line = readLog()[0];

      // Beginning of the message only, matching channel.ts's text preview.
      expect(line).toContain(`transcript="${"x".repeat(77)}..."`);
      // Nothing is lost: the real length still rides along.
      expect(line).toContain("chars=300");
    }
  );

  it("a note that never downloaded still leaves its ids behind", async () => {
    const noPath = {
      getFile: async () => ({ file_id: "v", file_unique_id: "u", file_path: null }),
      downloadFile: async () => Buffer.from(""),
    } as unknown as TelegramApi;
    const readLog = captureLog();

    await dispatchFile(voiceMessage(), noPath, filesDir, false, asr("http://127.0.0.1:1"));
    const line = readLog()[0];

    expect(line).toContain("outcome=no_file_path");
    expect(line).toContain("msg=9001");
    expect(line).toContain("file_id=voice_1");
    expect(line).not.toContain("clip=");
  });

  it("feature off is recorded too — a kept-but-untranscribed clip has a reason", async () => {
    const readLog = captureLog();
    await dispatchFile(voiceMessage(), api, filesDir, false, null);
    const line = readLog()[0];

    expect(line).toContain("outcome=asr_disabled");
    expect(line).toContain(`clip=files/${VOICE_FILE}`);
    expect(line).not.toContain("model=");
  });

  it("ASR server refusing or unreachable drops silently but keeps the clip", async () => {
    const stub = await startStubAsr(() => ({
      status: 503,
      body: { error: { message: "could not load model" } },
    }));
    closeStub = stub.close;

    const result = await dispatchFile(voiceMessage(), api, filesDir, false, asr(stub.endpoint));
    expect(result!.prompt).toEqual({ drop: "silent" });

    const dead = await dispatchFile(
      voiceMessage(),
      api,
      filesDir,
      false,
      asr("http://127.0.0.1:1")
    );
    expect(dead!.prompt).toEqual({ drop: "silent" });
    expect(existsSync(join(filesDir, VOICE_FILE))).toBe(true);
  });

  it("undownloadable voice note drops silently (no file id to keep)", async () => {
    const noPath = {
      getFile: async () => ({ file_id: "v", file_unique_id: "u", file_path: null }),
      downloadFile: async () => Buffer.from(""),
    } as unknown as TelegramApi;

    const result = await dispatchFile(voiceMessage(), noPath, filesDir, false, asr("http://127.0.0.1:1"));
    expect(result!.prompt).toEqual({ drop: "silent" });
    expect(existsSync(join(filesDir, VOICE_FILE))).toBe(false);
  });

  it("a download that throws is recorded with its ids and rethrown untouched", async () => {
    const exploding = {
      getFile: async () => ({ file_id: "voice_1", file_unique_id: "VjVxYz9", file_path: "files/voice_1.ogg" }),
      downloadFile: async () => {
        throw new Error("telegram edge refused");
      },
    } as unknown as TelegramApi;
    const readLog = captureLog();

    await expect(dispatchFile(voiceMessage(), exploding, filesDir, false, asr("http://127.0.0.1:1"))).rejects.toThrow(
      "telegram edge refused"
    );
    const line = readLog()[0];
    // The upstream catch logs the error but never the message id; this is the
    // line that says which note it was.
    expect(line).toContain("outcome=download_failed");
    expect(line).toContain("msg=9001");
    expect(line).toContain("file_id=voice_1");
    expect(line).toContain('error="telegram edge refused"');
  });
});
