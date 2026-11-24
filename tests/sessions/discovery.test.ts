import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { discoverSessionFiles } from "../../src/sessions/discovery";

describe("discoverSessionFiles", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "spindle-discovery-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns empty list when dir does not exist", async () => {
    const result = await discoverSessionFiles(join(dir, "does-not-exist"));
    expect(result).toEqual([]);
  });

  it("finds *.jsonl files and returns id + path + size", async () => {
    await writeFile(join(dir, "a.jsonl"), "hello\n");
    await writeFile(join(dir, "b.jsonl"), "world\n");
    const result = await discoverSessionFiles(dir);
    expect(result).toHaveLength(2);
    const ids = result.map((r) => r.id).sort();
    expect(ids).toEqual(["a", "b"]);
    for (const r of result) {
      expect(r.size).toBeGreaterThan(0);
      expect(r.path.endsWith(".jsonl")).toBe(true);
    }
  });

  it("ignores dotfiles", async () => {
    await writeFile(join(dir, ".hidden.jsonl"), "x");
    await writeFile(join(dir, "visible.jsonl"), "y");
    const result = await discoverSessionFiles(dir);
    expect(result.map((r) => r.id)).toEqual(["visible"]);
  });

  it("ignores non-jsonl files", async () => {
    await writeFile(join(dir, "notes.md"), "x");
    await writeFile(join(dir, "config.json"), "{}");
    await writeFile(join(dir, "good.jsonl"), "y");
    const result = await discoverSessionFiles(dir);
    expect(result.map((r) => r.id)).toEqual(["good"]);
  });

  it("ignores subdirectories", async () => {
    await mkdir(join(dir, "subdir.jsonl")); // weirdly named directory
    await writeFile(join(dir, "file.jsonl"), "x");
    const result = await discoverSessionFiles(dir);
    expect(result.map((r) => r.id)).toEqual(["file"]);
  });
});
