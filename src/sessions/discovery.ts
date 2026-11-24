import { readdir, stat } from "fs/promises";
import { basename, extname, join } from "path";

export interface DiscoveredSession {
  /** Basename without `.jsonl` — used as the session id. */
  id: string;
  /** Absolute file path on disk. */
  path: string;
  /** Current file size in bytes (for watermark comparison). */
  size: number;
  /** Filesystem mtime in ms. */
  mtimeMs: number;
}

/**
 * Enumerate pi session files in `dir`. Ignores dotfiles and anything
 * not ending in `.jsonl`. If `dir` does not exist the caller usually
 * wants an empty list rather than an error (pi hasn't created it yet
 * on a fresh agent), so we catch ENOENT and return [].
 */
export async function discoverSessionFiles(
  dir: string
): Promise<DiscoveredSession[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const out: DiscoveredSession[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    if (extname(entry) !== ".jsonl") continue;
    const fullPath = join(dir, entry);
    try {
      const s = await stat(fullPath);
      if (!s.isFile()) continue;
      out.push({
        id: basename(entry, ".jsonl"),
        path: fullPath,
        size: s.size,
        mtimeMs: s.mtimeMs,
      });
    } catch {
      // Races with rotation/delete: just skip the entry.
      continue;
    }
  }

  return out;
}
