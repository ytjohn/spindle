/**
 * SchedulerRunner — cron-based ephemeral session dispatcher.
 *
 * Reads `.pi/schedule.yaml` (or a configured override path), registers a
 * croner job per enabled `schedules.ephemeral` entry, and hot-reloads when
 * the file changes via fs.watch. Each tick spawns an ephemeral pi session,
 * sends the command string (e.g. "/mail-check") as the first user message,
 * waits until the run settles (agent_settled, after pi's own retries; see
 * settle.ts), and logs the result to `.pi/scheduler.log` and
 * `.pi/scheduler-sessions/`.
 *
 * Per-command in-flight guard: if a command's previous invocation hasn't
 * finished, the new tick is dropped (logged as skipped). This prevents
 * concurrent runs of the same long-running slash command.
 */

import { watch, existsSync, mkdirSync, appendFileSync, statSync } from "fs";
import { join, dirname } from "path";
import { Cron } from "croner";
import { loadScheduleConfig, type ScheduleEntry } from "./config";
import { createSchedulerSessionFactory, type SchedulerSessionFactory } from "./factory";
import { isIdle, parseIdleThreshold } from "./idle";
import { runUntilSettled } from "./settle";
import type { SharedSessionDeps } from "../agent/session";

export interface SchedulerRunnerOptions {
  agentDir: string;
  scheduleFile: string;
  deps: SharedSessionDeps;
  /**
   * Path to the main session JSONL (for idle detection). Can also be the
   * sessions directory. Falls back to `{agentDir}/.pi/sessions` if absent.
   */
  piSessionFile?: string;
}

interface LogEntry {
  /**
   * The entry's `id` if set in schedule.yaml; otherwise omitted. Lets
   * operators distinguish multiple entries sharing the same command
   * (e.g. /briefing at 7am vs 8pm) when grep-ing the scheduler log.
   */
  id?: string;
  command: string;
  started_at: string;
  duration_ms: number;
  skipped?: boolean;
  skip_reason?: string;
  errored?: boolean;
  error_message?: string;
  /**
   * The run hit timeout_minutes and was cut off mid-turn. Distinct from
   * `errored`: nothing failed, the clock ran out, and whatever the run had
   * not written down is gone.
   */
  timed_out?: boolean;
  /** pi automatic retries during the run (stream drops, 5xx, rate limits). */
  retries?: number;
}

export class SchedulerRunner {
  private readonly agentDir: string;
  private readonly scheduleFile: string;
  private readonly sessionFactory: SchedulerSessionFactory;
  private readonly piSessionFile: string;

  private jobs: Cron[] = [];
  private watcher: ReturnType<typeof watch> | null = null;
  private reloadDebounce: ReturnType<typeof setTimeout> | null = null;
  private loadedSignature = "";
  private readonly inFlight = new Set<string>();
  // In-flight session promises + close handles, so stop() can drain (and
  // force-close on timeout) before spindle calls process.exit(). Without
  // this, ephemeral sessions keep running and may be SIGKILL'd mid-write,
  // corrupting downstream SQLite WALs (e.g. obs-ingester's sessions.db).
  private readonly inFlightSessions = new Map<
    Promise<void>,
    { close: () => Promise<void>; label: string }
  >();
  private running = false;
  // Max time stop() waits for in-flight sessions before force-closing.
  private static readonly DRAIN_TIMEOUT_MS = 10_000;

  constructor(opts: SchedulerRunnerOptions) {
    this.agentDir = opts.agentDir;
    this.scheduleFile = opts.scheduleFile;
    this.sessionFactory = createSchedulerSessionFactory(opts.deps);
    // Default idle-check location: the main session file if provided,
    // otherwise the conventional pi sessions directory under the agent.
    this.piSessionFile =
      opts.piSessionFile ?? join(opts.agentDir, ".pi", "sessions");
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.reload();
    this.watchFile();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.clearJobs();
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.reloadDebounce) {
      clearTimeout(this.reloadDebounce);
      this.reloadDebounce = null;
    }

    // Drain in-flight ephemeral sessions before returning. Spindle's shutdown
    // flow expects this method to complete; if we return while sessions are
    // still running, process.exit() kills them mid-write.
    if (this.inFlightSessions.size > 0) {
      const labels = Array.from(this.inFlightSessions.values()).map((v) => v.label);
      console.log(
        `[scheduler] Draining ${this.inFlightSessions.size} in-flight session(s): ${labels.join(", ")}`
      );

      const drained = Promise.allSettled(Array.from(this.inFlightSessions.keys()));
      const timeout = new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), SchedulerRunner.DRAIN_TIMEOUT_MS)
      );

      const result = await Promise.race([drained.then(() => "drained" as const), timeout]);

      if (result === "timeout") {
        const stragglers = Array.from(this.inFlightSessions.values());
        console.warn(
          `[scheduler] Drain timeout after ${SchedulerRunner.DRAIN_TIMEOUT_MS}ms — force-closing ${stragglers.length} session(s)`
        );
        await Promise.allSettled(stragglers.map((s) => s.close()));
      }
    }
  }

  private clearJobs(): void {
    for (const job of this.jobs) {
      try {
        job.stop();
      } catch {
        // ignore
      }
    }
    this.jobs = [];
  }

  /** inode:mtime:size of schedule.yaml, or "missing". See watchFile(). */
  private fileSignature(): string {
    try {
      const st = statSync(this.scheduleFile);
      return `${st.ino}:${st.mtimeMs}:${st.size}`;
    } catch {
      return "missing";
    }
  }

  private async reload(): Promise<void> {
    this.loadedSignature = this.fileSignature();
    this.clearJobs();

    let config;
    try {
      config = loadScheduleConfig(this.scheduleFile);
    } catch (err) {
      console.error(
        `[scheduler] Failed to parse ${this.scheduleFile}: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }

    const enabled = config.ephemeral.filter((e) => e.enabled !== false);

    for (const entry of enabled) {
      try {
        const job = new Cron(entry.schedule, async () => {
          await this.fireCommand(entry);
        });
        this.jobs.push(job);
        const desc = entry.description ? ` (${entry.description})` : "";
        const idSuffix = entry.id ? ` [id=${entry.id}]` : "";
        const modelSuffix = entry.model ? ` [model=${entry.model}]` : "";
        console.log(
          `[scheduler] Registered "${entry.command}"${idSuffix}${desc}${modelSuffix} on "${entry.schedule}"`
        );
      } catch (err) {
        console.error(
          `[scheduler] Invalid schedule for "${entry.command}": ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    console.log(
      `[scheduler] ${this.jobs.length} job(s) active from ${this.scheduleFile}`
    );
  }

  private watchFile(): void {
    // fs.watch isn't available on all platforms and can throw for missing paths.
    // Treat failures as non-fatal — we just lose hot-reload, not scheduling.
    //
    // Watch the DIRECTORY, not the file. fs.watch on a file
    // follows its inode; an editor or git atomic replace (write temp + rename)
    // leaves the watcher on the orphaned inode and it never fires again — a
    // schedule edit looked applied while the running scheduler kept the old
    // config until restart. A directory watch survives renames.
    // Do NOT filter on the event's filename: under bun a rename INTO the
    // target is reported only under the temp file's name (tested:
    // "rename schedule.yaml.tmp", never "schedule.yaml"). Instead, on any
    // event, reload only if the file's identity (inode/mtime/size) changed.
    try {
      this.watcher = watch(dirname(this.scheduleFile), () => {
        // Fixed window, not a resetting debounce: in a busy directory a
        // resetting one could postpone the check indefinitely.
        if (this.reloadDebounce) return;
        this.reloadDebounce = setTimeout(async () => {
          this.reloadDebounce = null;
          if (!this.running) return;
          if (this.fileSignature() === this.loadedSignature) return;
          console.log("[scheduler] schedule.yaml changed — reloading jobs");
          await this.reload();
        }, 500);
      });
    } catch (err) {
      console.warn(
        `[scheduler] Could not watch ${this.scheduleFile}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async fireCommand(entry: ScheduleEntry): Promise<void> {
    // Key for the in-flight guard and label suffix. Defaults to command so
    // existing entries (no `id`) behave exactly as before. When `id` is set,
    // each entry has its own slot — multiple schedule entries for the same
    // command no longer block each other (e.g. /briefing at 7am vs 8pm).
    const key = entry.id ?? entry.command;
    const label = `[scheduler:${key}]`;
    const startedAt = Date.now();

    // Per-key in-flight guard
    if (this.inFlight.has(key)) {
      console.log(`${label} Previous invocation still running — skipping tick`);
      this.writeLog({
        id: entry.id,
        command: entry.command,
        started_at: new Date(startedAt).toISOString(),
        duration_ms: 0,
        skipped: true,
        skip_reason: "in_flight",
      });
      return;
    }

    // Idle check
    if (entry.idle_only && entry.idle_threshold) {
      let thresholdMs: number;
      try {
        thresholdMs = parseIdleThreshold(entry.idle_threshold);
      } catch (err) {
        console.error(`${label} ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (!isIdle(this.piSessionFile, thresholdMs)) {
        console.log(
          `${label} Skipping — not idle (threshold: ${entry.idle_threshold})`
        );
        this.writeLog({
          id: entry.id,
          command: entry.command,
          started_at: new Date(startedAt).toISOString(),
          duration_ms: 0,
          skipped: true,
          skip_reason: "not_idle",
        });
        return;
      }
    }

    if (!this.running) {
      console.log(`${label} Shutdown in progress — skipping tick`);
      return;
    }

    this.inFlight.add(key);
    // Register the runSession promise so stop() can drain it. We have to
    // register before awaiting, and unregister after. Tracking by the promise
    // itself keeps the bookkeeping race-free.
    let registered: Promise<void> | null = null;
    let sessionRef: { close: () => void | Promise<void> } | null = null;
    const runPromise = (async () => {
      await this.runSession(entry, label, startedAt, (s) => {
        sessionRef = s;
        if (registered) {
          this.inFlightSessions.set(registered, {
            close: async () => { await s.close(); },
            label,
          });
        }
      });
    })();
    registered = runPromise;
    // If runSession already registered a session before we got here, patch it in.
    if (sessionRef) {
      this.inFlightSessions.set(registered, {
        close: async () => { await sessionRef!.close(); },
        label,
      });
    }
    try {
      await runPromise;
    } finally {
      this.inFlight.delete(key);
      this.inFlightSessions.delete(runPromise);
    }
  }

  private async runSession(
    entry: ScheduleEntry,
    label: string,
    startedAt: number,
    onSessionReady?: (session: { close: () => void | Promise<void> }) => void
  ): Promise<void> {
    console.log(`${label} Firing ephemeral session`);

    let session;
    try {
      session = await this.sessionFactory(entry);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${label} Failed to create session: ${msg}`);
      this.writeLog({
        id: entry.id,
        command: entry.command,
        started_at: new Date(startedAt).toISOString(),
        duration_ms: Date.now() - startedAt,
        errored: true,
        error_message: msg,
      });
      return;
    }

    onSessionReady?.(session);

    const SESSION_TIMEOUT_MS = entry.timeout_minutes === -1
      ? Infinity
      : (entry.timeout_minutes ?? 5) * 60_000;

    let outcome;
    try {
      outcome = await runUntilSettled(session, entry.command, SESSION_TIMEOUT_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${label} Session error: ${msg}`);
      this.writeLog({
        id: entry.id,
        command: entry.command,
        started_at: new Date(startedAt).toISOString(),
        duration_ms: Date.now() - startedAt,
        errored: true,
        error_message: msg,
      });
      this.writeSessionLog(entry, startedAt, "");
      return;
    } finally {
      try {
        await session.close();
      } catch {
        // ignore
      }
    }
    const { turnEnded, turnError, assistantText, retries, timedOut } = outcome;
    if (retries > 0) {
      console.log(`${label} ${turnError ? "still failed" : "recovered"} after ${retries} automatic retr${retries === 1 ? "y" : "ies"}`);
    }

    const durationMs = Date.now() - startedAt;

    if (turnError) {
      console.error(`${label} LLM error: ${turnError}`);
      this.writeLog({
        id: entry.id,
        command: entry.command,
        started_at: new Date(startedAt).toISOString(),
        duration_ms: durationMs,
        errored: true,
        error_message: turnError,
        retries: retries || undefined,
      });
      this.writeSessionLog(entry, startedAt, assistantText);
      return;
    }

    if (!turnEnded) {
      console.warn(`${label} session resolved without agent_end`);
    }

    // A run cut off at timeout_minutes used to be indistinguishable from one
    // that finished: settle.ts set timedOut and nothing read it, so the line
    // below said "Completed" either way and scheduler.log recorded nothing.
    // Whatever the run was doing is lost at this point, so say so loudly —
    // a silent kill is how work disappears without anyone noticing.
    if (timedOut) {
      console.warn(
        `${label} TIMED OUT after ${durationMs}ms (timeout_minutes) — session cut off mid-run, ` +
        `anything it had not written down is lost`,
      );
    }

    console.log(`${label} ${timedOut ? "Cut off" : "Completed"} in ${durationMs}ms`);
    this.writeLog({
      id: entry.id,
      command: entry.command,
      started_at: new Date(startedAt).toISOString(),
      duration_ms: durationMs,
      retries: retries || undefined,
      timed_out: timedOut || undefined,
    });
    if (assistantText.trim()) {
      this.writeSessionLog(entry, startedAt, assistantText);
    }
  }

  private writeLog(entry: LogEntry): void {
    try {
      const piDir = join(this.agentDir, ".pi");
      if (!existsSync(piDir)) mkdirSync(piDir, { recursive: true });
      appendFileSync(join(piDir, "scheduler.log"), JSON.stringify(entry) + "\n");
    } catch {
      // log write failure is not fatal
    }
  }

  private writeSessionLog(
    entry: ScheduleEntry,
    startedAt: number,
    output: string
  ): void {
    try {
      // Group by entry.id when set, else by command slug. Matches the
      // in-flight guard key so entries that share a command but have
      // distinct ids (e.g. briefing-morning vs briefing-evening) land
      // in separate subdirs instead of intermixing.
      const key = entry.id ?? entry.command;
      const slug = key.replace(/[^a-zA-Z0-9-]/g, "") || "session";
      const sessionDir = join(this.agentDir, ".pi", "scheduler-sessions", slug);
      mkdirSync(sessionDir, { recursive: true });
      const ts = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
      const filePath = join(sessionDir, `${ts}.txt`);
      const idLine = entry.id ? `id: ${entry.id}\n` : "";
      appendFileSync(
        filePath,
        `command: ${entry.command}\n${idLine}started_at: ${new Date(startedAt).toISOString()}\n\n${output}\n`
      );
    } catch {
      // not fatal
    }
  }
}
