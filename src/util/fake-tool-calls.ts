/**
 * Fake tool calls — tool invocations a model wrote as prose instead of
 * emitting through tool-use mode.
 *
 * Some models — notably some local models served by vLLM — reliably
 * emit a *correct*, well-formed call as plain assistant text but never
 * trip tool-use mode. Observed: a full session of 258 events
 * contained 255 text blocks and zero tool calls, yet the text carried 60
 * `mud_move(...)`, 20 `mud_cmd(...)`, and 2 `imagine(prompt=...)` calls.
 *
 * Two distinct jobs live here, and they must not be conflated:
 *
 *   1. MASKING (safety). A call-shaped span must never reach a human as
 *      prose. The operator once received a raw image prompt string over
 *      Telegram because the relay had no idea the text was a tool call.
 *      Masking is length-preserving so caller-side offsets stay valid.
 *
 *   2. RESCUING (recovery). Where the caller owns the underlying effect
 *      — a MUD channel owns `channel.send`, an image extension owns
 *      its ComfyUI pipeline — the parsed call can simply be run for the
 *      model. Rescue is always caller-side: pi's ExtensionAPI exposes no
 *      cross-extension tool invocation (`getAllTools()` returns only
 *      name/description/parameters), so there is no generic executor and
 *      this module deliberately does not pretend otherwise.
 *
 * Detection is a curated name list rather than a generic `\w+\(` pattern.
 * Generic matching would eat ordinary prose — "the alley (twice)" or
 * "London(ish)" — and silently swallow real speech, which is a worse
 * failure than missing an exotic tool name. Add names here as tools are
 * registered.
 */

/**
 * Spindle's own tools whose text-shaped form should never reach a human.
 * Everything else comes from registerKnownToolNames(): an extension adds
 * the tools it registers, and agent.yaml `spindle.masked_tool_names` adds
 * names for extensions that do not.
 */
export const KNOWN_TOOL_NAMES: readonly string[] = [
  "telegram_send_message", "telegram_send_image",
  "spindle_memory_recall", "spindle_memory_store",
];

const EXTRA_KEY = Symbol.for("@spindle/known-tool-names");
function extraNames(): Set<string> {
  const g = globalThis as unknown as { [EXTRA_KEY]?: Set<string> };
  return (g[EXTRA_KEY] ??= new Set());
}

/**
 * Add tool names to the masked set. An extension that registers its own
 * tools calls this at register time, so a model that writes one of them
 * as text has it masked the same way as the built-in names. Process-wide:
 * extensions load in pi's own module graph.
 */
export function registerKnownToolNames(names: readonly string[]): void {
  const extra = extraNames();
  for (const n of names) if (/^\w+$/.test(n)) extra.add(n);
}

/** The built-in names plus everything registered. */
export function knownToolNames(): readonly string[] {
  const extra = extraNames();
  if (extra.size === 0) return KNOWN_TOOL_NAMES;
  return [...new Set([...KNOWN_TOOL_NAMES, ...extra])];
}

const RELAY_KEY = Symbol.for("@spindle/relay-tool-names");
function relayNames(): Set<string> {
  const g = globalThis as unknown as { [RELAY_KEY]?: Set<string> };
  return (g[RELAY_KEY] ??= new Set());
}

/**
 * Tools whose whole purpose is to send their first argument to the
 * operator as a message. When a model writes such a call as prose in a
 * reply that is already on its way to the operator, masking it would
 * throw away exactly the words meant to arrive — so the channel sends
 * the argument as the reply instead. Registering a name here also makes
 * it a known tool name.
 */
export function registerRelayToolNames(names: readonly string[]): void {
  registerKnownToolNames(names);
  const relay = relayNames();
  for (const n of names) if (/^\w+$/.test(n)) relay.add(n);
}

export function isRelayToolName(name: string): boolean {
  return relayNames().has(name);
}

/** Test-only. */
export function _resetKnownToolNames(): void {
  extraNames().clear();
  relayNames().clear();
}

// Argument body: balanced-ish `( ... )` that tolerates parentheses and
// commas inside quoted strings. `imagine(prompt="a lit sign (closed)")`
// must mask as one span, not stop at the inner `)` and leave `")` behind
// as visible garbage.
const ARG_BODY = String.raw`\((?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^)'"])*\)`;

function namesAlternation(names: readonly string[]): string {
  // Longest-first so `image_combine` cannot be shadowed by a shorter
  // prefix alternative during matching.
  return [...names].sort((a, b) => b.length - a.length).join("|");
}

/** Matches a complete call-shaped span: `name(...)`. */
export function fakeToolCallRegex(names: readonly string[] = knownToolNames()): RegExp {
  return new RegExp(String.raw`\b(?:${namesAlternation(names)})\s*${ARG_BODY}`, "g");
}

/**
 * Matches a call-shaped span whose closing paren never arrived — the
 * token-cliff truncation signature (`imagine(prompt="Night patrol in`).
 * Anything from the opening name onward is unrecoverable fragment, so
 * callers truncate rather than mask.
 */
export function truncatedToolCallRegex(names: readonly string[] = knownToolNames()): RegExp {
  return new RegExp(String.raw`\b(?:${namesAlternation(names)})\s*\(`);
}

/**
 * Qwen3's native tool-call syntax leaks as bare XML tags when the vllm
 * parser half-consumes a call: `[mud_say("...") </parameter> </function>
 * </tool_call>` once reached Telegram with only the name(...)
 * span masked. These tags are never human-addressed content.
 */
export const QWEN_XML_ARTIFACT_RE =
  /<\/?(?:tool_call|function|parameter)(?:=[^>]{0,160})?>/g;

/**
 * A call written with the closing paren dropped but the quote and a
 * wrapping bracket closed — `mud_emote("glances at phone, smirks"]` —
 * a systematic local-model quirk. Complete-span
 * matching misses it and it is not at end-of-text, so it needs its own
 * span pattern rather than the truncation path.
 */
function malformedCloseRegexSource(names: readonly string[]): string {
  return String.raw`(?:${namesAlternation(names)})\s*\(\s*"(?:[^"\\]|\\.)*"\s*\]`;
}

/** True when `text` contains at least one complete call-shaped span. */
export function containsFakeToolCall(
  text: string,
  names: readonly string[] = knownToolNames(),
): boolean {
  // Fresh regex per call — a /g regex's lastIndex is stateful and a
  // shared instance would skip matches on alternating inputs.
  return fakeToolCallRegex(names).test(text);
}

/**
 * Gate predicate for relay paths: true when the text carries ANY
 * call-shaped content — complete span, malformed-close span, truncated
 * cliff fragment, or bare qwen XML artifact. flushCurrentResponse
 * originally gated on containsFakeToolCall (complete spans only), which
 * let the malformed `mud_emote("..."]` form through to Telegram
 * verbatim.
 */
export function hasCallShapedContent(
  text: string,
  names: readonly string[] = knownToolNames(),
): boolean {
  if (fakeToolCallRegex(names).test(text)) return true;
  if (new RegExp(malformedCloseRegexSource(names)).test(text)) return true;
  if (truncatedToolCallRegex(names).test(text)) return true;
  if (new RegExp(QWEN_XML_ARTIFACT_RE.source).test(text)) return true;
  return false;
}

/**
 * Blank out every call-shaped span, preserving length so offsets that
 * callers computed against the original text remain valid.
 *
 * Also truncates at an unterminated call — a fragment cannot be masked
 * by span because it has no end, and leaving it would relay half a
 * prompt string.
 */
export function maskFakeToolCalls(
  text: string,
  names: readonly string[] = knownToolNames(),
): string {
  // Matching bracket/backtick wrappers go with the call: a model writes
  // `[mud_emote("...")]`, and masking only the call span leaves stray
  // "[ ]" garbage in the say line.
  const call = String.raw`(?:${namesAlternation(names)})\s*${ARG_BODY}`;
  const malformed = malformedCloseRegexSource(names);
  const wrapped = new RegExp(
    String.raw`\[\s*${call}\s*\]|\`\s*${call}\s*\`|\b${call}|\[?\s*${malformed}|${QWEN_XML_ARTIFACT_RE.source}`,
    "g",
  );
  const masked = text.replace(wrapped, (m) => " ".repeat(m.length));
  const truncated = masked.search(truncatedToolCallRegex(names));
  if (truncated === -1) return masked;
  // A truncated call may carry its own opening wrapper ("handle. [mud_emote(…"
  // cut mid-stream) — trim the dangling punctuation along with the fragment.
  return masked.slice(0, truncated).replace(/[\s\[\(`]+$/, "");
}

export interface ParsedFakeCall {
  /** Tool name as written. */
  name: string;
  /** Positional arguments, quotes stripped. */
  positional: string[];
  /** Named (`key=value` / `key: value`) arguments, quotes stripped. */
  named: Record<string, string>;
  /** Offset of the match in the source text, for ordering. */
  index: number;
  /** The full matched span. */
  raw: string;
}

/** Split an argument body on top-level commas, respecting quoting. */
function splitArgs(body: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quote) {
      if (ch === "\\" && i + 1 < body.length) {
        cur += ch + body[++i];
        continue;
      }
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ",") {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function unquote(s: string): string {
  const t = s.trim();
  if (
    t.length >= 2 &&
    ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
  ) {
    return t.slice(1, -1).replace(/\\(["'\\])/g, "$1");
  }
  return t;
}

// `prompt="..."` and `prompt: "..."` are both observed. The key must be
// a bare identifier so a positional string containing `=` (a MUD command
// like `page someone = hi`) is not mistaken for a named argument.
const NAMED_ARG_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*([\s\S]+)$/;

/**
 * Parse every call-shaped span in `text`, in written order.
 *
 * Handles both the positional form the mud_* tools use
 * (`mud_move("south")`) and the named-kwarg form the image tools use
 * (`imagine(prompt="...", width=1024)`).
 */
export function parseFakeToolCalls(
  text: string,
  names: readonly string[] = knownToolNames(),
): ParsedFakeCall[] {
  const out: ParsedFakeCall[] = [];
  // Malformed-close spans (`mud_emote("watches him"]` — paren dropped,
  // quote + bracket closed) parse too: the argument is unambiguous, and
  // without this the model's emotes are masked but never fire, leaving
  // the character inert (observed: a scene's emotes silently dropped).
  const malformed = new RegExp(malformedCloseRegexSource(names), "g");
  for (const m of text.matchAll(malformed)) {
    const raw = m[0];
    const open = raw.indexOf("(");
    const name = raw.slice(0, open).trim();
    const quoted = raw.slice(open + 1, raw.lastIndexOf("]")).trim();
    out.push({ name, positional: [unquote(quoted)], named: {}, index: m.index ?? 0, raw });
  }
  for (const m of text.matchAll(fakeToolCallRegex(names))) {
    const raw = m[0];
    const open = raw.indexOf("(");
    const name = raw.slice(0, open).trim();
    const body = raw.slice(open + 1, raw.lastIndexOf(")"));
    const positional: string[] = [];
    const named: Record<string, string> = {};
    for (const part of splitArgs(body)) {
      const kv = NAMED_ARG_RE.exec(part);
      if (kv) named[kv[1]!] = unquote(kv[2]!);
      else positional.push(unquote(part));
    }
    out.push({ name, positional, named, index: m.index ?? 0, raw });
  }
  return out.sort((a, b) => a.index - b.index);
}

/**
 * First argument of a parsed call, whichever form the model used:
 * a named argument matching one of `keys`, else the first positional.
 * Returns "" when the call had no usable argument.
 */
export function primaryArg(call: ParsedFakeCall, ...keys: string[]): string {
  for (const k of keys) {
    const v = call.named[k];
    if (v !== undefined && v.trim().length > 0) return v.trim();
  }
  return (call.positional[0] ?? "").trim();
}
