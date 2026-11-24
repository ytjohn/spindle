/**
 * Session activity reader for the daydream loop.
 *
 * Reads a pi-agent session JSONL file, filters entries by a watermark
 * timestamp, and produces a simplified conversation list suitable for
 * the daydream prompt builder.
 *
 * Why read the file instead of the live `AgentSession` object:
 * - Session files are append-only, so tail-from-timestamp is trivial
 * - Avoids racing pi's own writes to the session manager
 * - Forward-compatible with a future cross-session daydream that reads
 *   multiple session files per cycle
 * - Testable without mocking `AgentSession` internals
 *
 * Entry format (from probing a real session file):
 *   {type: "session", version, id, timestamp, cwd}        -- header, line 1
 *   {type: "model_change", ...}                            -- metadata events
 *   {type: "thinking_level_change", ...}                   -- metadata events
 *   {type: "message", id, parentId, timestamp,
 *      message: { role, content: [block, ...] }}
 *
 *   Block types we care about:
 *     {type: "text", text: "..."}                          -- user/assistant text
 *     {type: "thinking", thinking: "..."}                  -- assistant reasoning (skipped)
 *     {type: "toolCall", id, name, arguments}              -- tool invocations
 *     {type: "tool_result", content: [...]}                -- tool responses
 */

import { readFileSync, existsSync } from "fs";

export type MessageRole = "user" | "assistant" | "toolResult";

/**
 * Simplified turn representation for the daydream prompt builder. One
 * entry per *message* — we collapse multiple text blocks in a single
 * assistant message into one `text` field joined with newlines.
 */
export interface ActivityTurn {
  timestamp: number; // unix ms
  role: MessageRole;
  /** Flattened text from all text blocks in the message. Empty if only thinking/tool blocks. */
  text: string;
  /** Names of any tools the assistant invoked in this turn. Empty array for user/toolResult. */
  toolCalls: string[];
}

/**
 * Read entries from a pi session JSONL file that were appended at or
 * after `sinceMs`. Returns the turns in chronological order. Malformed
 * lines are skipped with a console warning (we don't fail the whole
 * cycle on one bad row). Missing / unreadable file returns `[]`.
 *
 * Only `type: "message"` entries are returned — session header,
 * model_change, and thinking_level_change events are filtered out.
 */
export function readSessionEntriesSince(
  sessionFile: string,
  sinceMs: number
): ActivityTurn[] {
  if (!existsSync(sessionFile)) return [];

  let content: string;
  try {
    content = readFileSync(sessionFile, "utf-8");
  } catch (err) {
    console.warn(`[daydream] failed to read session file ${sessionFile}:`, err);
    return [];
  }

  const lines = content.split("\n").filter((l) => l.length > 0);
  const turns: ActivityTurn[] = [];

  for (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      console.warn(`[daydream] skipped malformed JSONL line in ${sessionFile}`);
      continue;
    }
    const turn = entryToTurn(entry);
    if (!turn) continue;
    if (turn.timestamp < sinceMs) continue;
    turns.push(turn);
  }

  return turns;
}

/**
 * Extract a simplified turn from a raw JSONL entry, or null if the
 * entry isn't a conversational message. Exported for tests.
 */
export function entryToTurn(raw: unknown): ActivityTurn | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  if (entry.type !== "message") return null;

  const timestampStr = entry.timestamp as string | undefined;
  if (!timestampStr) return null;
  const timestamp = Date.parse(timestampStr);
  if (Number.isNaN(timestamp)) return null;

  const message = entry.message as
    | { role?: string; content?: unknown }
    | undefined;
  if (!message) return null;

  const role = message.role;
  if (role !== "user" && role !== "assistant" && role !== "toolResult") {
    return null;
  }

  const texts: string[] = [];
  const toolCalls: string[] = [];

  if (typeof message.content === "string") {
    texts.push(message.content);
  } else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      const btype = b.type;
      if (btype === "text" && typeof b.text === "string") {
        texts.push(b.text);
      } else if (btype === "toolCall" && typeof b.name === "string") {
        toolCalls.push(b.name);
      }
      // "thinking" blocks are deliberately skipped — they're private
      // reasoning, not worth reviewing in a daydream pass.
      // "tool_result" blocks inside toolResult messages are handled by
      // the role filter above; their content is not included in the
      // activity summary (the daydream doesn't need to re-read tool
      // outputs, only the conversation that produced them).
    }
  }

  return {
    timestamp,
    role,
    text: texts.join("\n").trim(),
    toolCalls,
  };
}

/**
 * Render a list of turns as a single prose block for the daydream
 * prompt. Skips toolResult turns entirely (tool output isn't relevant
 * to "what's worth remembering"), collapses assistant tool calls into
 * a short "(called X, Y)" annotation, and caps total output at
 * `maxChars` by dropping the oldest turns first.
 *
 * Format example:
 *
 *   Recent activity (7 new turns over the last 45m):
 *
 *   [10:15] user: I just moved to Lisbon last week
 *   [10:15] assistant: Welcome to Lisbon!
 *   [10:18] user: My cat's name is Pixel
 *   [10:18] assistant: That's a great name. (called spindle_memory_store)
 *   ...
 */
export function summarizeActivity(
  turns: ActivityTurn[],
  now: number,
  opts: { maxChars?: number } = {}
): string {
  const maxChars = opts.maxChars ?? 4000;
  const visible = turns.filter((t) => t.role !== "toolResult" && t.text.length > 0);

  if (visible.length === 0) {
    return "No new conversational activity since the last cycle.";
  }

  const oldest = visible[0].timestamp;
  const elapsedMs = now - oldest;
  const elapsedLabel = formatElapsed(elapsedMs);

  const header = `Recent activity (${visible.length} ${
    visible.length === 1 ? "turn" : "turns"
  } over the last ${elapsedLabel}):`;

  const lines: string[] = [];
  // Build from newest backward so we can trim oldest when we hit the cap,
  // then reverse for chronological display.
  const rendered: string[] = [];
  for (let i = visible.length - 1; i >= 0; i--) {
    rendered.push(renderTurn(visible[i]));
  }
  rendered.reverse();

  // Trim oldest if we exceed maxChars
  let total = header.length + 2; // for the blank line after header
  const kept: string[] = [];
  for (let i = rendered.length - 1; i >= 0; i--) {
    const cost = rendered[i].length + 1; // +1 for newline
    if (total + cost > maxChars && kept.length > 0) break;
    kept.unshift(rendered[i]);
    total += cost;
  }

  if (kept.length < rendered.length) {
    const dropped = rendered.length - kept.length;
    lines.push(
      `${header}\n(${dropped} older turn${dropped === 1 ? "" : "s"} elided for length)\n`
    );
  } else {
    lines.push(`${header}\n`);
  }
  lines.push(...kept);

  return lines.join("\n");
}

function renderTurn(turn: ActivityTurn): string {
  const time = new Date(turn.timestamp).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  const toolNote =
    turn.toolCalls.length > 0
      ? ` (called ${turn.toolCalls.join(", ")})`
      : "";
  // Collapse internal whitespace so a multi-paragraph turn reads as
  // one line in the summary. This is coarse but keeps the prompt
  // compact — the daydream is reviewing intent, not wording.
  const text = turn.text.replace(/\s+/g, " ").trim();
  return `[${time}] ${turn.role}: ${text}${toolNote}`;
}

function formatElapsed(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (remMinutes === 0) return `${hours}h`;
  return `${hours}h ${remMinutes}m`;
}
