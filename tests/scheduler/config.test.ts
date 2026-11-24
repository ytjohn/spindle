import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadScheduleConfig } from "../../src/scheduler/config";

function load(yaml: string) {
  const p = join(mkdtempSync(join(tmpdir(), "sched-")), "schedule.yaml");
  writeFileSync(p, yaml);
  return loadScheduleConfig(p).ephemeral;
}

describe("loadScheduleConfig", () => {
  it("keeps no_context_files (was dropped by the parser)", () => {
    const [e] = load(`schedules:\n  ephemeral:\n    - command: /x\n      schedule: "0 * * * *"\n      no_context_files: true\n`);
    expect(e.no_context_files).toBe(true);
  });

  it("keeps a valid thinking_level and model", () => {
    const [e] = load(`schedules:\n  ephemeral:\n    - command: /juno-auto\n      schedule: "*/30 * * * *"\n      model: local/small-model\n      thinking_level: low\n`);
    expect(e.thinking_level).toBe("low");
    expect(e.model).toBe("local/small-model");
  });

  it("drops an invalid thinking_level, leaving the default", () => {
    const [e] = load(`schedules:\n  ephemeral:\n    - command: /x\n      schedule: "0 * * * *"\n      thinking_level: extreme\n`);
    expect(e.thinking_level).toBeUndefined();
  });

  it("leaves both unset when omitted", () => {
    const [e] = load(`schedules:\n  ephemeral:\n    - command: /x\n      schedule: "0 * * * *"\n`);
    expect(e.thinking_level).toBeUndefined();
    expect(e.no_context_files).toBeUndefined();
  });
});
