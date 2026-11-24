import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaLog, mimeFor } from "../../src/media/log";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "media-log-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("MediaLog", () => {
  it("records with an opaque id and the sender's context, and notifies", () => {
    const log = new MediaLog(join(dir, ".pi", "media-log.jsonl"));
    log.setContext(() => ({ session: "s1", run: "run:1", toolCallId: "call_9" }));
    const seen: string[] = [];
    log.subscribe((m) => seen.push(m.id));
    const m = log.record({ type: "image", mime: "image/png", path: "/files/a.png", bytes: 7, via: "telegram", caption: "hi" });
    expect(m.id).toMatch(/^md_[0-9a-f]{12}$/);
    expect(m).toMatchObject({ session: "s1", run: "run:1", toolCallId: "call_9", caption: "hi" });
    expect(seen).toEqual([m.id]);
    expect(log.get(m.id)?.path).toBe("/files/a.png");
  });

  it("without a context the record has no session, and is still kept", () => {
    const log = new MediaLog(join(dir, "m.jsonl"));
    expect(log.record({ type: "voice", mime: "audio/ogg", path: "/f/v.ogg", bytes: 1, via: "telegram" }).session).toBeNull();
  });

  it("survives a restart: a new log reads the file, and skips a torn last line", () => {
    const file = join(dir, "m.jsonl");
    const a = new MediaLog(file);
    a.setContext(() => ({ session: "s1" }));
    const m = a.record({ type: "audio", mime: "audio/mpeg", path: "/f/song.mp3", bytes: 3, via: "telegram", durationMs: 2000 });
    a.setContext(() => ({ session: "s2" }));
    a.record({ type: "image", mime: "image/png", path: "/f/b.png", bytes: 3, via: "telegram" });
    appendFileSync(file, '{"id":"md_torn","pa');
    const b = new MediaLog(file);
    expect(b.get(m.id)?.durationMs).toBe(2000);
    expect(b.forSession("s1").map((x) => x.id)).toEqual([m.id]);
    expect(b.forSession("s2")).toHaveLength(1);
    expect(readFileSync(file, "utf8").split("\n").filter(Boolean)).toHaveLength(3);
  });

  it("a throwing listener does not stop the record", () => {
    const log = new MediaLog(join(dir, "m.jsonl"));
    log.subscribe(() => {
      throw new Error("boom");
    });
    expect(() => log.record({ type: "image", mime: "image/png", path: "/x.png", bytes: 1, via: "telegram" })).not.toThrow();
  });

  it("mime by extension", () => {
    expect(mimeFor("/a/B.JPG", "image")).toBe("image/jpeg");
    expect(mimeFor("/a/v.ogg", "voice")).toBe("audio/ogg");
    expect(mimeFor("/a/x.bin", "audio")).toBe("audio/octet-stream");
  });
});
