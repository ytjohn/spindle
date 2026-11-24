/**
 * Project a single pi JSONL session line into indexable columns.
 *
 * Design: the raw line is preserved verbatim in `content_json`, so any
 * column we project here can be changed or added later via an ALTER +
 * one-shot backfill. Don't try to extract everything — only columns
 * we're confident we'll query on today.
 */

export interface ProjectedEvent {
  byte_offset: number;
  ts: number | null;
  event_type: string;
  pi_event_id: string | null;
  parent_id: string | null;
  role: string | null;
  model: string | null;
  content_json: string;
  content_text: string | null;
}

export interface ParseError {
  error: true;
  byte_offset: number;
  message: string;
  raw: string;
}

export type ParseResult =
  | { error: false; event: ProjectedEvent }
  | ParseError;

/**
 * Parse one JSONL line. Never throws — returns a structured error
 * object the ingester can log + skip. Blank lines produce errors too
 * (callers filter those before calling); splitting responsibility
 * keeps this pure.
 */
export function parseEventLine(line: string, byteOffset: number): ParseResult {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return { error: true, byte_offset: byteOffset, message: "empty line", raw: line };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return {
      error: true,
      byte_offset: byteOffset,
      message: `json parse: ${err instanceof Error ? err.message : String(err)}`,
      raw: line,
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return {
      error: true,
      byte_offset: byteOffset,
      message: "line is not a json object",
      raw: line,
    };
  }

  const obj = parsed as Record<string, unknown>;
  const event_type = typeof obj.type === "string" ? obj.type : null;
  if (!event_type) {
    return {
      error: true,
      byte_offset: byteOffset,
      message: "missing .type field",
      raw: line,
    };
  }

  const pi_event_id = typeof obj.id === "string" ? obj.id : null;
  const parent_id =
    typeof obj.parentId === "string" ? obj.parentId : null;

  const ts = parseTimestamp(obj.timestamp);

  const message = obj.message;
  const messageObj =
    message && typeof message === "object"
      ? (message as Record<string, unknown>)
      : null;

  const role =
    messageObj && typeof messageObj.role === "string" ? messageObj.role : null;
  const model =
    messageObj && typeof messageObj.model === "string"
      ? messageObj.model
      : null;

  const content_text = extractContentText(event_type, messageObj);

  return {
    error: false,
    event: {
      byte_offset: byteOffset,
      ts,
      event_type,
      pi_event_id,
      parent_id,
      role,
      model,
      content_json: trimmed,
      content_text,
    },
  };
}

/**
 * Outer `.timestamp` is usually an ISO-8601 string in pi's format,
 * occasionally a number. Return ms since epoch, or null if neither.
 */
function parseTimestamp(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.length > 0) {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * Extract the searchable text portion of a message event. Returns null
 * for non-message events and for message events with no indexable
 * content (e.g. an assistant turn that was pure thinking). The thinking
 * type is deliberately skipped — it stays in content_json and can be
 * re-projected into FTS later if we decide to index it.
 */
function extractContentText(
  eventType: string,
  messageObj: Record<string, unknown> | null
): string | null {
  if (eventType !== "message" || !messageObj) return null;

  const content = messageObj.content;
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const type = typeof b.type === "string" ? b.type : null;
    if (!type) continue;

    if (type === "text") {
      if (typeof b.text === "string" && b.text.length > 0) parts.push(b.text);
    } else if (type === "tool_use") {
      const name = typeof b.name === "string" ? b.name : "tool";
      const args = compactArgsSummary(b.input);
      parts.push(args ? `${name}(${args})` : `${name}()`);
    } else if (type === "tool_result") {
      const txt = extractToolResultText(b.content);
      if (txt) parts.push(txt);
    }
    // `thinking` and unknown block types: skipped intentionally.
  }

  if (parts.length === 0) return null;
  return parts.join("\n");
}

/**
 * Best-effort single-line summary of tool_use input. Trims to 200 chars
 * so a huge payload doesn't dominate the FTS body. Full args remain in
 * content_json.
 */
function compactArgsSummary(input: unknown): string {
  if (input === undefined || input === null) return "";
  if (typeof input === "string") return clip(input, 200);
  if (typeof input === "object") {
    const entries: string[] = [];
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      entries.push(`${key}=${shortValue(value)}`);
    }
    return clip(entries.join(", "), 200);
  }
  return clip(String(input), 200);
}

function shortValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return JSON.stringify(clip(v, 80));
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return clip(JSON.stringify(v), 80);
}

/**
 * tool_result.content can be a string or an array of content blocks
 * like `[{type:"text", text:"..."}]`. Return a flattened string.
 */
function extractToolResultText(content: unknown): string | null {
  if (typeof content === "string") return content.length > 0 ? content : null;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (typeof b.text === "string" && b.text.length > 0) parts.push(b.text);
    }
    return parts.length > 0 ? parts.join("\n") : null;
  }
  return null;
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
