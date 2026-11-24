import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, renameSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SchedulerRunner } from "../../src/scheduler/runner";

/**
 * schedule.yaml hot-reload died after an atomic replace
 * (write temp + rename), because fs.watch on a FILE follows the orphaned
 * inode. The runner now watches the directory. The load-bearing case is the
 * SECOND replace: the first one is what used to orphan the watcher.
 */

const yaml = (n: number) =>
  "schedules:\n  ephemeral:\n" +
  Array.from({ length: n }, (_, i) =>
    `    - command: /noop-${i}\n      schedule: "0 0 1 1 *"\n`
  ).join("");

function atomicReplace(file: string, content: string) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

const jobCount = (r: SchedulerRunner) => (r as unknown as { jobs: unknown[] }).jobs.length;

async function waitFor(pred: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

describe("scheduler hot-reload", () => {
  let dir: string;
  let runner: SchedulerRunner | null = null;

  afterEach(async () => {
    await runner?.stop();
    runner = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps reloading across repeated atomic replaces of schedule.yaml", async () => {
    dir = mkdtempSync(join(tmpdir(), "sched-hot-"));
    const file = join(dir, "schedule.yaml");
    writeFileSync(file, yaml(1));
    runner = new SchedulerRunner({ agentDir: dir, scheduleFile: file, deps: {} as never });
    await runner.start();
    expect(jobCount(runner)).toBe(1);

    atomicReplace(file, yaml(2));
    expect(await waitFor(() => jobCount(runner!) === 2)).toBe(true);

    // *** the regression: a file watch is dead after the first rename
    atomicReplace(file, yaml(3));
    expect(await waitFor(() => jobCount(runner!) === 3)).toBe(true);

    // an in-place rewrite still works too
    writeFileSync(file, yaml(1));
    expect(await waitFor(() => jobCount(runner!) === 1)).toBe(true);
  });

  it("ignores other files in the same directory", async () => {
    dir = mkdtempSync(join(tmpdir(), "sched-hot-"));
    const file = join(dir, "schedule.yaml");
    writeFileSync(file, yaml(2));
    runner = new SchedulerRunner({ agentDir: dir, scheduleFile: file, deps: {} as never });
    await runner.start();
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
    try {
      writeFileSync(join(dir, "other.yaml"), "x: 1\n");
      await new Promise((r) => setTimeout(r, 900));
    } finally {
      console.log = orig;
    }
    expect(logs.some((l) => l.includes("schedule.yaml changed"))).toBe(false);
    expect(jobCount(runner)).toBe(2);
  });
});
