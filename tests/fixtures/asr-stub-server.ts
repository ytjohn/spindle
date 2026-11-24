/**
 * Test-only stand-in for the audio.cpp transcription endpoint.
 *
 * Deliberately picky in the one way the real server is picky: it records
 * exactly what was uploaded, so a test can prove the client sent WAV rather
 * than the OGG it was handed. The real server answers anything else with
 * "only WAV audio uploads are currently supported for transcription", and
 * that is not the kind of contract you want to discover in production.
 */
import { createServer, type Server } from "node:http";
import { spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";

export interface StubRequest {
  contentType: string;
  body: Buffer;
}

export interface StubAsr {
  /** Base URL to hand to AsrSettings, no trailing slash. */
  endpoint: string;
  requests: StubRequest[];
  close(): Promise<void>;
}

/**
 * `reply(status, json)` or `reply(null, ...)` to make the server hang up
 * mid-response (a client-side failure, not an HTTP one).
 */
export async function startStubAsr(
  reply: (req: StubRequest) => { status: number; body: unknown } | null
): Promise<StubAsr> {
  const requests: StubRequest[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
    req.on("end", () => {
      const captured: StubRequest = {
        contentType: String(req.headers["content-type"] ?? ""),
        body: Buffer.concat(chunks),
      };
      requests.push(captured);
      const out = reply?.(captured);
      if (!out) {
        res.destroy();
        return;
      }
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    endpoint: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}

/**
 * A valid 16 kHz mono PCM WAV with a tone in it — enough for ffmpeg to decode
 * without any fixture binary in the repo. ffmpeg probes content, not
 * extension, so this also stands in for an OGG when a test needs one.
 */
export function toneWav(samples = 1600, rate = 16000): Buffer {
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(Math.round(2000 * Math.sin(i / 9)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** ffmpeg is a hard requirement for this path; tests skip when it is absent. */
export function hasFfmpeg(): boolean {
  try {
    return spawnSync("ffmpeg", ["-version"]).status === 0;
  } catch {
    return false;
  }
}
