import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolveResumeMode,
  findMostRecentSession,
  type ResumeMode,
} from "../../src/agent/session";
import type { AgentConfig } from "../../src/types";

describe("resolveResumeMode", () => {
  const baseConfig: AgentConfig = { agent: { id: "test" } };

  it("defaults to 'new' when no config or override", () => {
    expect(resolveResumeMode(baseConfig)).toBe("new");
  });

  it("honors pi.continue_session: true from agent.yaml", () => {
    const config: AgentConfig = {
      ...baseConfig,
      pi: { continue_session: true },
    };
    expect(resolveResumeMode(config)).toBe("continue");
  });

  it("honors pi.resume_session path from agent.yaml", () => {
    const config: AgentConfig = {
      ...baseConfig,
      pi: { resume_session: "/path/to/session.jsonl" },
    };
    expect(resolveResumeMode(config)).toEqual({ path: "/path/to/session.jsonl" });
  });

  it("resume_session wins over continue_session when both are set", () => {
    const config: AgentConfig = {
      ...baseConfig,
      pi: { continue_session: true, resume_session: "/explicit.jsonl" },
    };
    expect(resolveResumeMode(config)).toEqual({ path: "/explicit.jsonl" });
  });

  it("CLI override wins over agent.yaml continue_session", () => {
    const config: AgentConfig = {
      ...baseConfig,
      pi: { continue_session: true },
    };
    expect(resolveResumeMode(config, "new")).toBe("new");
  });

  it("CLI override wins over agent.yaml resume_session", () => {
    const config: AgentConfig = {
      ...baseConfig,
      pi: { resume_session: "/from-yaml.jsonl" },
    };
    const override: ResumeMode = { path: "/from-cli.jsonl" };
    expect(resolveResumeMode(config, override)).toEqual({ path: "/from-cli.jsonl" });
  });

  it("CLI 'continue' override triggers continue mode even without config", () => {
    expect(resolveResumeMode(baseConfig, "continue")).toBe("continue");
  });
});

describe("findMostRecentSession", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "spindle-resume-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null for nonexistent directory", () => {
    expect(findMostRecentSession(join(dir, "does-not-exist"))).toBeNull();
  });

  it("returns null for empty directory", () => {
    expect(findMostRecentSession(dir)).toBeNull();
  });

  it("returns the only .jsonl file when there's one", () => {
    const p = join(dir, "alpha.jsonl");
    writeFileSync(p, "{}\n");
    expect(findMostRecentSession(dir)).toBe(p);
  });

  it("returns the most recently modified .jsonl file", () => {
    const older = join(dir, "older.jsonl");
    const newer = join(dir, "newer.jsonl");
    writeFileSync(older, "{}\n");
    writeFileSync(newer, "{}\n");
    // Force mtimes: older = 1h ago, newer = now
    const now = new Date();
    const hourAgo = new Date(now.getTime() - 3600 * 1000);
    utimesSync(older, hourAgo, hourAgo);
    utimesSync(newer, now, now);
    expect(findMostRecentSession(dir)).toBe(newer);
  });

  it("ignores non-.jsonl files", () => {
    writeFileSync(join(dir, "notes.md"), "# notes\n");
    writeFileSync(join(dir, "ignore.txt"), "x\n");
    expect(findMostRecentSession(dir)).toBeNull();
  });
});
