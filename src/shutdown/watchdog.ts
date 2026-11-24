/**
 * Out-of-process shutdown watchdog.
 *
 * spindle's shutdown() already bounds every step (8s) and arms a 30s
 * in-process hard exit. One agent still hung for systemd's full 90s
 * TimeoutStopSec on some stops, and neither the step warning nor the hard
 * exit ever logged: the main JS thread was blocked synchronously (or Bun's
 * process.exit itself never returned), so no timer in this process could
 * fire. Nothing inside the process can rescue that.
 *
 * So shutdown also spawns a tiny watchdog process. It holds the read end of a
 * pipe whose write end only this process holds: when this process exits, the
 * watchdog sees EOF and leaves quietly. If the pipe is still open after
 * `afterMs`, it logs each thread's state and kernel wait channel (the next
 * hang then says WHERE it is stuck — futex = runtime deadlock, etc.) and
 * SIGKILLs this process, well before systemd's timeout.
 *
 * Safe against PID reuse: on Linux the watchdog records the target's start
 * time when it starts and refuses to kill a process whose start time differs.
 */
import { spawn } from "child_process";

// Plain JS run with `<execPath> -e` (bun or node), configured by env vars so
// it does not depend on how either runtime lays out argv for -e.
const WATCHDOG_SOURCE = `
const fs = require("fs");
const pid = Number(process.env.SPINDLE_WD_PID);
const ms = Number(process.env.SPINDLE_WD_MS);
const label = process.env.SPINDLE_WD_LABEL || "spindle";
const startOf = (p) => {
  try {
    const s = fs.readFileSync("/proc/" + p + "/stat", "utf8");
    return s.slice(s.lastIndexOf(")") + 2).split(" ")[19];
  } catch { return null; }
};
const born = startOf(pid);
const leave = () => process.exit(0);
process.stdin.on("end", leave);
process.stdin.on("close", leave);
process.stdin.on("error", leave);
process.stdin.resume();
setTimeout(() => {
  if (born !== null && startOf(pid) !== born) leave();
  try { process.kill(pid, 0); } catch { leave(); }
  let threads = "";
  try {
    for (const t of fs.readdirSync("/proc/" + pid + "/task")) {
      const b = "/proc/" + pid + "/task/" + t + "/";
      try {
        const st = fs.readFileSync(b + "stat", "utf8");
        const state = st.slice(st.lastIndexOf(")") + 2).split(" ")[0];
        let wchan = "-";
        try { wchan = fs.readFileSync(b + "wchan", "utf8").trim() || "-"; } catch {}
        threads += " " + fs.readFileSync(b + "comm", "utf8").trim() + "[" + t + "]=" + state + "/" + wchan;
      } catch {}
    }
  } catch {}
  process.stderr.write(
    "[" + label + "] shutdown watchdog: pid " + pid + " still running " + ms +
    "ms after shutdown began; main thread blocked or exit hung. SIGKILL. threads:" +
    (threads || " (unavailable)") + "\\n"
  );
  try { process.kill(pid, "SIGKILL"); } catch {}
  leave();
}, ms);
`;

export interface ShutdownWatchdogOptions {
  /** How long the process may take to exit before it is SIGKILLed. */
  afterMs: number;
  /** Log prefix. */
  label?: string;
  /** Process to guard; defaults to this one. Tests only. */
  pid?: number;
}

/**
 * Spawn the watchdog. Returns its pid, or null if it could not be started —
 * a failure to arm must never stop shutdown from proceeding.
 */
export function armShutdownWatchdog(opts: ShutdownWatchdogOptions): number | null {
  const label = opts.label ?? "spindle";
  try {
    const child = spawn(process.execPath, ["-e", WATCHDOG_SOURCE], {
      // Own process group: a terminal Ctrl+C (SIGINT to the foreground group)
      // must not take the watchdog down with the process it guards.
      detached: true,
      stdio: ["pipe", "ignore", "inherit"],
      env: {
        ...process.env,
        SPINDLE_WD_PID: String(opts.pid ?? process.pid),
        SPINDLE_WD_MS: String(opts.afterMs),
        SPINDLE_WD_LABEL: label,
      },
    });
    child.on("error", (err) => {
      console.error(`[${label}] shutdown watchdog failed to start:`, err);
    });
    // Neither the child nor our end of its stdin may keep this loop alive.
    child.unref();
    (child.stdin as unknown as { unref?: () => void } | null)?.unref?.();
    return child.pid ?? null;
  } catch (err) {
    console.error(`[${label}] shutdown watchdog failed to start:`, err);
    return null;
  }
}
