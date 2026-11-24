/**
 * Sidecar marker file for the "main session" feature.
 *
 * The marker file `.main-session` lives in the session directory and
 * contains the absolute path to the pinned session JSONL file.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const MARKER_FILENAME = ".main-session";

/**
 * Read the main-session marker from a session directory.
 * Returns the absolute path to the pinned session file, or null if:
 *  - The marker doesn't exist
 *  - The marker is empty
 *  - The target file doesn't exist (stale marker)
 */
export function readMainSessionMarker(sessionDir: string): string | null {
  const markerPath = join(sessionDir, MARKER_FILENAME);
  if (!existsSync(markerPath)) return null;

  try {
    const content = readFileSync(markerPath, "utf-8").trim();
    if (!content) return null;
    if (!existsSync(content)) return null;
    return content;
  } catch {
    return null;
  }
}

/**
 * The pin itself, whether or not its file has been written yet.
 *
 * pi does not write a session's file until the session has something to
 * save, so the main session of an agent that has not spoken yet is pinned
 * to a path with nothing at it. That is still a pin: `exists` says which
 * case this is. Returns null only when there is no marker, or it is empty
 * or unreadable.
 */
export function readMainSessionPin(sessionDir: string): { path: string; exists: boolean } | null {
  const markerPath = join(sessionDir, MARKER_FILENAME);
  if (!existsSync(markerPath)) return null;
  try {
    const content = readFileSync(markerPath, "utf-8").trim();
    if (!content) return null;
    return { path: content, exists: existsSync(content) };
  } catch {
    return null;
  }
}

/**
 * Write (or overwrite) the main-session marker in a session directory.
 */
export function writeMainSessionMarker(
  sessionDir: string,
  sessionFilePath: string
): void {
  const markerPath = join(sessionDir, MARKER_FILENAME);
  writeFileSync(markerPath, sessionFilePath + "\n", "utf-8");
}
