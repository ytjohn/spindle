import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

// An agent's shutdown once hung with the main JS thread blocked, so the
// in-process 30s hard exit never fired. These tests run a real child process
// that arms the watchdog and then blocks its own thread synchronously.

const WATCHDOG = resolve(__dirname, "../../src/shutdown/watchdog.ts");

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function runChild(body: string): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string; ms: number }> {
  dir = mkdtempSync(join(tmpdir(), "spindle-wd-"));
  const script = join(dir, "child.ts");
  writeFileSync(script, `import { armShutdownWatchdog } from ${JSON.stringify(WATCHDOG)};\n${body}\n`);
  const t0 = Date.now();
  return new Promise((res) => {
    const p = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("exit", (code, signal) => {
      // Give the watchdog's stderr write a moment to drain through the pipe.
      setTimeout(() => res({ code, signal, stdout, stderr, ms: Date.now() - t0 }), 100);
    });
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("armShutdownWatchdog", () => {
  it("SIGKILLs a process whose main thread is blocked synchronously", async () => {
    const r = await runChild(`
      armShutdownWatchdog({ afterMs: 500 });
      // Block the JS thread for 20s: no timer in this process can fire.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20_000);
      console.log("unblocked");
    `);
    expect(r.signal).toBe("SIGKILL");
    expect(r.stdout).not.toContain("unblocked");
    expect(r.ms).toBeLessThan(8_000);
    expect(r.stderr).toContain("shutdown watchdog");
    expect(r.stderr).toContain("SIGKILL");
  });

  it("leaves quietly when the guarded process exits on its own", async () => {
    const r = await runChild(`
      const wd = armShutdownWatchdog({ afterMs: 1_500 });
      console.log("wd=" + wd);
      process.exit(0);
    `);
    expect(r.code).toBe(0);
    const wd = Number(/wd=(\d+)/.exec(r.stdout)?.[1]);
    expect(wd).toBeGreaterThan(0);
    // EOF on its stdin pipe ends it well before afterMs.
    const deadline = Date.now() + 1_000;
    while (alive(wd) && Date.now() < deadline) await new Promise((s) => setTimeout(s, 25));
    expect(alive(wd)).toBe(false);
    // ...and it never got to the kill branch.
    expect(r.stderr).not.toContain("shutdown watchdog");
  });

  it("does not keep the guarded process's event loop alive", async () => {
    const r = await runChild(`
      armShutdownWatchdog({ afterMs: 5_000 });
      console.log("armed");
    `);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("armed");
    expect(r.ms).toBeLessThan(4_000);
  });
});
