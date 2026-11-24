import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

/**
 * Parse a duration string like "30m", "1h", "2h30m" into milliseconds.
 * Accepts any combination of hours (h) and minutes (m).
 */
export function parseIdleThreshold(threshold: string): number {
  const match = threshold.match(/^(?:(\d+)h)?(?:(\d+)m)?$/);
  if (!match || (!match[1] && !match[2])) {
    throw new Error(`Invalid idle_threshold: "${threshold}" — use e.g. "30m", "1h", "1h30m"`);
  }
  const hours = parseInt(match[1] ?? "0", 10);
  const minutes = parseInt(match[2] ?? "0", 10);
  return (hours * 60 + minutes) * 60_000;
}

function findMostRecentJsonl(dir: string): string | null {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(dir, f))
      .map((p) => ({ path: p, mtime: statSync(p).mtime.getTime() }))
      .sort((a, b) => b.mtime - a.mtime);
    return files[0]?.path ?? null;
  } catch {
    return null;
  }
}

function getLastUserMessageFromFile(filePath: string): number | null {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const lines = content.split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i]);
      if (
        event.type === "message" &&
        event.message?.role === "user" &&
        event.timestamp
      ) {
        return new Date(event.timestamp).getTime();
      }
    } catch {
      // malformed line — skip
    }
  }
  return null;
}

/**
 * Get the timestamp of the last user message from the main session's JSONL.
 * Pass either a `.jsonl` file path or a directory — if a directory, scans
 * for the most recently modified `.jsonl` file.
 * Returns null if no user message is found.
 */
export function getLastUserMessageTimestamp(sessionFileOrDir: string): number | null {
  if (sessionFileOrDir.endsWith(".jsonl")) {
    return getLastUserMessageFromFile(sessionFileOrDir);
  }
  const latest = findMostRecentJsonl(sessionFileOrDir);
  if (!latest) return null;
  return getLastUserMessageFromFile(latest);
}

/**
 * Returns true if no user message has been seen within `thresholdMs`.
 * If no session activity exists at all, treats the agent as idle.
 */
export function isIdle(
  sessionFileOrDir: string,
  thresholdMs: number,
  now = Date.now()
): boolean {
  const lastUserMsg = getLastUserMessageTimestamp(sessionFileOrDir);
  if (lastUserMsg === null) return true;
  return now - lastUserMsg >= thresholdMs;
}
