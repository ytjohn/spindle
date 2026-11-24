import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { readMainSessionMarker, writeMainSessionMarker } from "../../src/agent/marker";

describe("marker utilities", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "spindle-marker-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("readMainSessionMarker", () => {
    it("returns null when marker does not exist", () => {
      expect(readMainSessionMarker(dir)).toBeNull();
    });

    it("returns the path from the marker file", () => {
      const sessionPath = join(dir, "2026-01-01_abc.jsonl");
      writeFileSync(sessionPath, ""); // create the target
      writeFileSync(join(dir, ".main-session"), sessionPath + "\n");
      expect(readMainSessionMarker(dir)).toBe(sessionPath);
    });

    it("returns null when marker points to non-existent file", () => {
      writeFileSync(join(dir, ".main-session"), "/no/such/file.jsonl\n");
      expect(readMainSessionMarker(dir)).toBeNull();
    });

    it("trims whitespace from marker content", () => {
      const sessionPath = join(dir, "session.jsonl");
      writeFileSync(sessionPath, "");
      writeFileSync(join(dir, ".main-session"), `  ${sessionPath}  \n`);
      expect(readMainSessionMarker(dir)).toBe(sessionPath);
    });
  });

  describe("writeMainSessionMarker", () => {
    it("creates the marker file with the session path", () => {
      const sessionPath = join(dir, "my-session.jsonl");
      writeMainSessionMarker(dir, sessionPath);
      const content = readFileSync(join(dir, ".main-session"), "utf-8").trim();
      expect(content).toBe(sessionPath);
    });

    it("overwrites an existing marker", () => {
      writeFileSync(join(dir, ".main-session"), "/old/path.jsonl\n");
      const newPath = join(dir, "new.jsonl");
      writeMainSessionMarker(dir, newPath);
      const content = readFileSync(join(dir, ".main-session"), "utf-8").trim();
      expect(content).toBe(newPath);
    });
  });
});
