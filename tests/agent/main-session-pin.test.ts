/**
 * main_session pins one session file as the agent's main session. pi
 * writes a session's file only once it has something to save, so an
 * agent whose main session stays quiet has a pin to a path with nothing
 * at it — while other sessions kept in the same folder (a channel's
 * one-off sessions) do get written. The pin must hold anyway.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildSessionManager } from "../../src/agent/session";
import { readMainSessionPin, writeMainSessionMarker } from "../../src/agent/marker";

let root = "";
let agentDir = "";
let sessionDir = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "spindle-pin-"));
  agentDir = root;
  sessionDir = join(root, "sessions");
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

/** A session that did some work and so has a file on disk, as a one-off session does. */
function writtenSession(): string {
  const mgr = SessionManager.create(agentDir, sessionDir);
  mgr.appendMessage({ role: "user", content: [{ type: "text", text: "side question" }], timestamp: Date.now() } as never);
  mgr.appendMessage({ role: "assistant", content: [{ type: "text", text: "side answer" }], timestamp: Date.now() } as never);
  const file = mgr.getSessionFile()!;
  expect(existsSync(file), "the helper session should have been written").toBe(true);
  // Make sure it is the newest file in the folder by a clear margin.
  const later = new Date(Date.now() + 60_000);
  utimesSync(file, later, later);
  return file;
}

/** What createSpindleSession does after building the manager in "main" mode. */
function boot(): { file: string; mgr: SessionManager } {
  const mgr = buildSessionManager("main", agentDir, sessionDir);
  const file = mgr.getSessionFile()!;
  if (!readMainSessionPin(sessionDir)) writeMainSessionMarker(sessionDir, file);
  return { file, mgr };
}

describe("main_session pin", () => {
  it("first boot pins a session whose file does not exist yet, and that is still a pin", () => {
    const first = boot();
    expect(existsSync(first.file)).toBe(false);
    expect(readMainSessionPin(sessionDir)).toEqual({ path: first.file, exists: false });
  });

  it("a quiet main session keeps its pin across a restart even when a one-off session was written beside it", () => {
    const first = boot();
    const oneOff = writtenSession();
    expect(oneOff).not.toBe(first.file);

    const second = boot();
    expect(second.file).toBe(first.file);
    expect(readMainSessionPin(sessionDir)).toEqual({ path: first.file, exists: true });
    // The pinned path is now a real, empty pi session — not the one-off's history.
    const lines = readFileSync(first.file, "utf8").trim().split("\n");
    expect(JSON.parse(lines[0]).type).toBe("session");
    expect(readFileSync(first.file, "utf8")).not.toContain("side question");

    // And it holds on every restart after that, with more one-offs arriving.
    writtenSession();
    const third = boot();
    expect(third.file).toBe(first.file);
    expect(readMainSessionPin(sessionDir)?.path).toBe(first.file);
  });

  it("the main session's own history survives: a pin with a file resumes that file", () => {
    const first = boot();
    first.mgr.appendMessage({ role: "user", content: [{ type: "text", text: "main question" }], timestamp: Date.now() } as never);
    first.mgr.appendMessage({ role: "assistant", content: [{ type: "text", text: "main answer" }], timestamp: Date.now() } as never);
    expect(existsSync(first.file)).toBe(true);
    const size = statSync(first.file).size;
    writtenSession();

    const second = boot();
    expect(second.file).toBe(first.file);
    expect(statSync(first.file).size).toBe(size);
    expect(JSON.stringify(second.mgr.getEntries())).toContain("main answer");
  });

  it("with no marker at all, the most recent session is adopted — the path for an agent that predates the feature", () => {
    const existing = writtenSession();
    const adopted = boot();
    expect(adopted.file).toBe(existing);
    expect(readMainSessionPin(sessionDir)).toEqual({ path: existing, exists: true });
  });
});
