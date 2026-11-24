import { parse } from "yaml";
import { readFileSync } from "fs";

export interface ScheduleEntry {
  /**
   * Optional unique identifier for the entry. When present, the in-flight
   * guard and log labels use this instead of `command`. Lets the same
   * command run at multiple schedule times without entries blocking each
   * other (e.g. /briefing at 7am AND 8pm). Falls back to `command`
   * when omitted.
   */
  id?: string;
  command: string;
  description?: string;
  enabled?: boolean;
  schedule: string;
  idle_only?: boolean;
  idle_threshold?: string;
  /** Max session duration in minutes. Defaults to the schedule interval. Use -1 for no timeout. */
  timeout_minutes?: number;
  /** Optional tool allowlist. When set, only these tool names are enabled for the ephemeral session. */
  tools?: string[];
  /**
   * Optional model override for this scheduled command. Uses provider/model
   * format (e.g. "local/model"). When set, the ephemeral
   * session runs against this model instead of the agent's main model.
   * Resolved via ModelRuntime at session creation time.
   */
  model?: string;
  /**
   * Suppress AGENTS.md / STATE.md and other context files for this entry's
   * ephemeral session.
   *
   * Ephemeral sessions otherwise inherit the agent's full persona and
   * operational state — 27KB of it on one agent. For a command that
   * exists to JUDGE other agents' transcripts, that is a priming hazard
   * even when the content is entirely correct: a STATE.md that
   * legitimately tracks which agents were restarted for looping primes an
   * inspector that reads it first to over-report loops in the transcripts
   * it then reviews.
   *
   * memento-distill.ts has always set noContextFiles for the same reason;
   * this exposes it to scheduler entries.
   *
   * Default false — a command that speaks in the agent's voice wants persona.
   */
  no_context_files?: boolean;
  /**
   * Thinking level for this entry's ephemeral session ("off" | "minimal" |
   * "low" | "medium" | "high" | "xhigh"). Default "off", as every scheduled
   * session has always run. Set it for a job whose quality depends on
   * reasoning, e.g. research dispatched by a scheduled command.
   */
  thinking_level?: string;
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

export interface ScheduleConfig {
  ephemeral: ScheduleEntry[];
}

interface RawScheduleFile {
  schedules?: {
    ephemeral?: unknown[];
  };
}

export function loadScheduleConfig(filePath: string): ScheduleConfig {
  const content = readFileSync(filePath, "utf8");
  const raw = parse(content) as RawScheduleFile;

  if (!raw || typeof raw !== "object") {
    throw new Error("schedule.yaml is not a valid YAML object");
  }

  const rawEphemeral = raw.schedules?.ephemeral;
  if (!Array.isArray(rawEphemeral)) {
    return { ephemeral: [] };
  }

  const ephemeral: ScheduleEntry[] = [];
  for (const item of rawEphemeral) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;

    if (typeof entry.command !== "string" || !entry.command) {
      console.warn("[scheduler] schedule entry missing command, skipping:", entry);
      continue;
    }
    if (typeof entry.schedule !== "string" || !entry.schedule) {
      console.warn("[scheduler] schedule entry missing schedule, skipping:", entry);
      continue;
    }

    if (entry.thinking_level !== undefined && !(typeof entry.thinking_level === "string" && THINKING_LEVELS.has(entry.thinking_level))) {
      console.warn(`[scheduler] ${entry.command}: invalid thinking_level ${JSON.stringify(entry.thinking_level)} — using "off"`);
    }
    ephemeral.push({
      id: typeof entry.id === "string" && entry.id ? entry.id : undefined,
      command: entry.command,
      description: typeof entry.description === "string" ? entry.description : undefined,
      enabled: typeof entry.enabled === "boolean" ? entry.enabled : true,
      schedule: entry.schedule,
      idle_only: typeof entry.idle_only === "boolean" ? entry.idle_only : undefined,
      idle_threshold: typeof entry.idle_threshold === "string" ? entry.idle_threshold : undefined,
      timeout_minutes: typeof entry.timeout_minutes === "number" ? entry.timeout_minutes : undefined,
      tools: Array.isArray(entry.tools) && entry.tools.every(t => typeof t === "string") ? entry.tools as string[] : undefined,
      model: typeof entry.model === "string" && entry.model ? entry.model : undefined,
      // Was missing: the field was declared and read by the factory but never
      // copied here, so no_context_files: true was silently ignored.
      no_context_files: typeof entry.no_context_files === "boolean" ? entry.no_context_files : undefined,
      thinking_level: typeof entry.thinking_level === "string" && THINKING_LEVELS.has(entry.thinking_level)
        ? entry.thinking_level : undefined,
    });
  }

  return { ephemeral };
}
