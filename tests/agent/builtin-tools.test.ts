/**
 * pi.tools chooses which of pi's built-in tools an agent starts with.
 * For a long time it chose nothing: it was handed to pi under an option
 * name pi does not read, and every agent started with read, bash, edit
 * and write whatever its config said.
 *
 * pi reads the choice from its `defaultTools` setting, through the
 * settings manager, after its resource loader has reloaded that manager
 * from disk — so the choice has to survive a reload.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { applyBuiltinToolChoice } from "../../src/agent/session";

let dir = "";
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "spindle-tools-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** What pi's createAgentSession sees: the manager after the loader reloaded it. */
async function afterLoaderReload(sm: SettingsManager): Promise<string[] | undefined> {
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager: sm,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
  });
  await loader.reload();
  return sm.getDefaultTools();
}

describe("pi.tools", () => {
  it("unset leaves pi's own default alone", async () => {
    const sm = SettingsManager.create(dir);
    const before = sm.getDefaultTools();
    expect(applyBuiltinToolChoice(sm, undefined)).toBeUndefined();
    expect(await afterLoaderReload(sm)).toEqual(before);
  });

  it("a list is what pi sees, still there after the loader reloads the settings", async () => {
    const sm = SettingsManager.create(dir);
    expect(applyBuiltinToolChoice(sm, ["read"])).toEqual(["read"]);
    expect(await afterLoaderReload(sm)).toEqual(["read"]);
    // And after a second reload, as each helper session's loader does.
    expect(await afterLoaderReload(sm)).toEqual(["read"]);
  });

  it("an empty list means no built-in tools, not the default", async () => {
    const sm = SettingsManager.create(dir);
    applyBuiltinToolChoice(sm, []);
    expect(await afterLoaderReload(sm)).toEqual([]);
  });

  it("hands out a copy each time, so a caller cannot widen the choice", () => {
    const sm = SettingsManager.create(dir);
    applyBuiltinToolChoice(sm, ["read"]);
    sm.getDefaultTools()!.push("bash");
    expect(sm.getDefaultTools()).toEqual(["read"]);
  });

  it("the plain override pi offers does NOT survive the reload — which is why it is not used", async () => {
    const sm = SettingsManager.create(dir);
    sm.applyOverrides({ defaultTools: ["read"] });
    expect(sm.getDefaultTools()).toEqual(["read"]);
    expect(await afterLoaderReload(sm)).not.toEqual(["read"]);
  });
});
