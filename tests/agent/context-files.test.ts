/**
 * pi.context_files decides which AGENTS.md / CLAUDE.md files reach the
 * system prompt. The main session has always applied it; helper sessions
 * (scheduled runs, daydream, a channel's one-off sessions) did not, and
 * got pi's default — every such file from the agent directory up to /.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { helperContextFiles, resolveContextFilesOptions } from "../../src/agent/session";

let project = "";
let agentDir = "";

beforeAll(() => {
  // A project with instructions for coding agents, and an agent kept in
  // a sub-folder of it with its own.
  project = realpathSync(mkdtempSync(join(tmpdir(), "spindle-context-")));
  agentDir = join(project, "agents", "ada");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(project, "AGENTS.md"), "PROJECT: instructions for coding agents working on this repository.\n");
  writeFileSync(join(agentDir, "AGENTS.md"), "AGENT: you are Ada.\n");
  writeFileSync(join(agentDir, "EXTRA.md"), "EXTRA: listed explicitly.\n");
});
afterAll(() => rmSync(project, { recursive: true, force: true }));

/** What a helper session built with these deps would put in its prompt. */
async function loaded(options: ReturnType<typeof helperContextFiles>): Promise<string[]> {
  const loader = new DefaultResourceLoader({
    cwd: agentDir,
    agentDir,
    settingsManager: SettingsManager.create(agentDir),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    ...options,
  });
  await loader.reload();
  return loader.getAgentsFiles().agentsFiles.map((f) => f.content.trim().split(":")[0]);
}

describe("context files in helper sessions", () => {
  it("pi's own default walks up: this is what a helper session used to get", async () => {
    const all = await loaded({});
    expect(all).toContain("PROJECT");
    expect(all).toContain("AGENT");
  });

  it("a helper session gets the main session's choice: by default only the agent directory's own file", async () => {
    const deps = { contextFiles: resolveContextFilesOptions(undefined, agentDir) };
    expect(await loaded(helperContextFiles(deps))).toEqual(["AGENT"]);
    const explicit = { contextFiles: resolveContextFilesOptions("agent_dir_only", agentDir) };
    expect(await loaded(helperContextFiles(explicit))).toEqual(["AGENT"]);
  });

  it("follows the other modes too: an explicit list, none, and auto", async () => {
    const list = { contextFiles: resolveContextFilesOptions(["EXTRA.md"], agentDir) };
    expect(await loaded(helperContextFiles(list))).toEqual(["EXTRA"]);

    const none = { contextFiles: resolveContextFilesOptions("none", agentDir) };
    expect(await loaded(helperContextFiles(none))).toEqual([]);

    // auto resolves to no options at all: pi's walk, parents included.
    expect(resolveContextFilesOptions("auto", agentDir)).toBeUndefined();
    const auto = await loaded(helperContextFiles({ contextFiles: undefined }));
    expect(auto).toContain("PROJECT");
    expect(auto).toContain("AGENT");
  });

  it("one session can still ask for none at all, whatever the agent's setting", async () => {
    const deps = { contextFiles: resolveContextFilesOptions(undefined, agentDir) };
    expect(helperContextFiles(deps, { noContextFiles: true })).toEqual({ noContextFiles: true });
    expect(await loaded(helperContextFiles(deps, { noContextFiles: true }))).toEqual([]);
    expect(await loaded(helperContextFiles(deps, { noContextFiles: false }))).toEqual(["AGENT"]);
  });
});
