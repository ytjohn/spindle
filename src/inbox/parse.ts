/**
 * Phase 4.4a frontmatter + multi-file mail parser.
 *
 * Files on disk are the source of truth; this module is the only layer
 * that turns bytes on disk into structured `ParsedMailFile` records.
 * The projector consumes the output; the engine calls `serializeMailFile`
 * on the other side to produce bytes to write.
 *
 * Design choices:
 *   - Uses the `yaml` package (already a dep via config/loader) so
 *     frontmatter supports nested metadata + multi-line strings.
 *   - Backwards-compatible with the legacy mail shape: `from` +
 *     `subject` + `date` + `priority` round-trip unchanged. Missing
 *     `id` is synthesized from filename (projector will persist the
 *     synthesis on write-back in 4.4b's migration pass).
 *   - Malformed files throw `MailParseError`; projector catches +
 *     logs + skips without advancing FTS/DB state for the bad file.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { createHash } from "crypto";
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { basename, extname, dirname, join, relative, isAbsolute } from "path";
import type {
  DiscoveredMailFile,
  MailFrontmatter,
  MailSource,
  MessageKind,
  MessagePriority,
  DeliveryStatus,
  DraftStatus,
  ParsedMailFile,
} from "./types";

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/;

const VALID_PRIORITIES: ReadonlySet<MessagePriority> = new Set([
  "low",
  "normal",
  "high",
  "urgent",
]);
const VALID_KINDS: ReadonlySet<MessageKind> = new Set([
  "message",
  "task",
  "notice",
  "reply",
]);
const VALID_DELIVERY_STATUSES: ReadonlySet<DeliveryStatus> = new Set([
  "delivered",
  "unrouted",
  "failed",
]);
const VALID_DRAFT_STATUSES: ReadonlySet<DraftStatus> = new Set([
  "draft",
  "ready",
]);

export class MailParseError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "MailParseError";
    this.path = path;
  }
}

export interface DiscoverOptions {
  /** Include source subdirs that would otherwise return. Defaults to all 5. */
  include?: ReadonlyArray<MailSource>;
}

/**
 * Walk `{mail_root}/inbox`, `/inbox/read`, `/inbox/tombstoned`,
 * `/outbox`, `/drafts`. Returns every `.md` file and every
 * `message.md` inside a subdirectory. Non-`.md` files at the root
 * level of a mail dir are ignored (they're either stray or belong to a
 * multi-file message dir we've already handled).
 *
 * Missing directories are silently skipped — a fresh agent boot runs
 * before `mkdir` so this has to be robust to absent paths.
 */
export function discoverMailFiles(
  mailRoot: string,
  options: DiscoverOptions = {}
): DiscoveredMailFile[] {
  const include: ReadonlyArray<MailSource> =
    options.include ?? ["inbox", "inbox/read", "inbox/tombstoned", "outbox", "drafts"];

  const out: DiscoveredMailFile[] = [];
  for (const source of include) {
    const dir = join(mailRoot, source);
    if (!existsSync(dir)) continue;
    walkMailDir(mailRoot, dir, source, out);
  }
  return out;
}

function walkMailDir(
  mailRoot: string,
  dir: string,
  source: MailSource,
  out: DiscoveredMailFile[]
): void {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    // Skip the source-typed subdirectories at the inbox level so we
    // don't re-walk inbox/read/ when we're still enumerating inbox/.
    if (source === "inbox" && entry.isDirectory()) {
      if (entry.name === "read" || entry.name === "tombstoned") continue;
      // Could be a multi-file message dir. Look for message.md inside.
      const msgFile = join(dir, entry.name, "message.md");
      if (existsSync(msgFile)) {
        pushMessageDirEntry(mailRoot, dir, entry.name, source, out);
      }
      continue;
    }
    if (entry.isDirectory()) {
      // read/ and tombstoned/ + outbox/ + drafts/ also support multi-file
      // message subdirs.
      const msgFile = join(dir, entry.name, "message.md");
      if (existsSync(msgFile)) {
        pushMessageDirEntry(mailRoot, dir, entry.name, source, out);
      }
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;
    const abs = join(dir, entry.name);
    const st = statSync(abs);
    out.push({
      absPath: abs,
      relPath: relative(mailRoot, abs),
      source,
      messageDir: null,
      mtime: st.mtimeMs,
      size: st.size,
    });
  }
}

function pushMessageDirEntry(
  mailRoot: string,
  parentDir: string,
  subdirName: string,
  source: MailSource,
  out: DiscoveredMailFile[]
): void {
  const msgDir = join(parentDir, subdirName);
  const abs = join(msgDir, "message.md");
  const st = statSync(abs);
  out.push({
    absPath: abs,
    relPath: relative(mailRoot, abs),
    source,
    messageDir: msgDir,
    mtime: st.mtimeMs,
    size: st.size,
  });
}

/**
 * Parse one `.md` mail file. If the path points at `{dir}/message.md`,
 * sibling non-`.md` files are picked up as attachments.
 */
export function parseMailFile(
  absPath: string,
  mailRoot: string,
  source: MailSource
): ParsedMailFile {
  if (!existsSync(absPath)) {
    throw new MailParseError(absPath, "file does not exist");
  }
  const rawBytes = readFileSync(absPath);
  const raw = rawBytes.toString("utf8");
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    throw new MailParseError(absPath, "no YAML frontmatter (--- delimiters missing)");
  }
  let fm: Record<string, unknown>;
  try {
    const parsed = parseYaml(match[1]);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("frontmatter is not an object");
    }
    fm = parsed as Record<string, unknown>;
  } catch (yamlErr) {
    // Fall back to a flat `key: value` line parser for historical files
    // that have unquoted colons in scalar values (e.g.
    // `subject: RE: Series 7 grip sensor reading high`). The legacy
    // inbox extension wrote with a regex-based parser that didn't
    // care about colon ambiguity; strict YAML does.
    //
    // Only engaged when the full YAML parse throws, so new-format files
    // with nested `metadata:` blocks still parse with proper YAML
    // semantics. Legacy parser handles scalars only — indented /
    // multi-line / nested values are dropped.
    const legacy = parseLegacyFrontmatter(match[1]);
    if (Object.keys(legacy).length === 0) {
      throw new MailParseError(
        absPath,
        `invalid YAML frontmatter: ${yamlErr instanceof Error ? yamlErr.message : String(yamlErr)}`
      );
    }
    fm = legacy;
  }
  const body = match[2].trim();

  // Synthesize id from filename if absent (legacy-import compat).
  const id = normalizeId(fm.id, absPath);
  const frontmatter: MailFrontmatter = {
    id,
    from_auth: typeof fm.from_auth === "string" ? fm.from_auth : undefined,
    from: requireString(fm, "from", absPath),
    to: typeof fm.to === "string" && fm.to.length > 0 ? fm.to : undefined,
    subject: typeof fm.subject === "string" ? fm.subject : undefined,
    date: requireString(fm, "date", absPath),
    priority: validPriority(fm.priority, absPath),
    kind: validKind(fm.kind, absPath),
    thread_id: typeof fm.thread_id === "string" ? fm.thread_id : undefined,
    in_reply_to:
      typeof fm.in_reply_to === "string" ? fm.in_reply_to : undefined,
    metadata: validMetadata(fm.metadata, absPath),
    draft_status: validDraftStatus(fm.draft_status, absPath),
    delivery_status: validDeliveryStatus(fm.delivery_status, absPath),
    delivery_error:
      typeof fm.delivery_error === "string" ? fm.delivery_error : undefined,
    to_mail_root:
      typeof fm.to_mail_root === "string" ? fm.to_mail_root : undefined,
  };

  const sha256 = hashBytes(rawBytes);
  const st = statSync(absPath);
  const messageDir =
    basename(absPath) === "message.md" ? dirname(absPath) : null;

  const attachments: ParsedMailFile["attachments"] = [];
  if (messageDir) {
    const siblings = readdirSync(messageDir, { withFileTypes: true });
    for (const s of siblings) {
      if (!s.isFile()) continue;
      if (s.name === "message.md") continue;
      const attAbs = join(messageDir, s.name);
      const attStat = statSync(attAbs);
      const attBytes = readFileSync(attAbs);
      attachments.push({
        filename: s.name,
        absPath: attAbs,
        relPath: relative(mailRoot, attAbs),
        sizeBytes: attStat.size,
        sha256: hashBytes(attBytes),
        contentType: guessContentType(s.name),
      });
    }
  }

  return {
    frontmatter,
    body,
    attachments,
    source,
    relPath: relative(mailRoot, absPath),
    sha256,
    mtime: st.mtimeMs,
  };
}

/**
 * Build the bytes to write for a mail file. Used by engine.send() and
 * draft save. Always produces a UTF-8 string; caller writes atomically
 * via temp-file-then-rename.
 */
export function serializeMailFile(
  frontmatter: MailFrontmatter,
  body: string
): string {
  const yamlText = stringifyYaml(cleanFrontmatter(frontmatter), {
    lineWidth: 0,
  });
  return `---\n${yamlText}---\n\n${body.trim()}\n`;
}

function cleanFrontmatter(fm: MailFrontmatter): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

export function hashBytes(bytes: Buffer | Uint8Array | string): string {
  const h = createHash("sha256");
  h.update(bytes);
  return h.digest("hex");
}

export function hashFile(absPath: string): string {
  return hashBytes(readFileSync(absPath));
}

/**
 * Flat scalar frontmatter parser. Handles `key: value` on its own line,
 * with arbitrary characters (including colons) in the value. Skips
 * indented lines, empty lines, comments, and lines that don't match
 * the `key: value` pattern. Returns whatever it could recover.
 *
 * Engaged ONLY as a fallback when strict YAML parsing throws — see
 * parseMailFile() for the full rationale.
 */
function parseLegacyFrontmatter(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.length === 0) continue;
    // Indented = probably nested mapping content. Legacy parser cannot
    // represent nested values — drop.
    if (/^\s/.test(rawLine)) continue;
    if (rawLine.trimStart().startsWith("#")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(rawLine);
    if (!m) continue;
    const key = m[1];
    const value = m[2].trim();
    result[key] = value;
  }
  return result;
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  path: string
): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new MailParseError(path, `frontmatter field '${key}' is required`);
  }
  return v;
}

function normalizeId(raw: unknown, absPath: string): string {
  if (typeof raw === "string" && raw.length > 0) return raw;
  // Legacy-import compatibility: derive from filename.
  let base = basename(absPath);
  if (base === "message.md") {
    base = basename(dirname(absPath));
  } else {
    base = base.replace(/\.md$/, "");
  }
  if (base.length === 0) {
    throw new MailParseError(absPath, "cannot derive id from empty filename");
  }
  return base;
}

function validPriority(
  v: unknown,
  path: string
): MessagePriority | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw new MailParseError(path, `invalid priority type: ${typeof v}`);
  }
  if (!VALID_PRIORITIES.has(v as MessagePriority)) {
    throw new MailParseError(path, `invalid priority: ${v}`);
  }
  return v as MessagePriority;
}

function validKind(v: unknown, path: string): MessageKind | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw new MailParseError(path, `invalid kind type: ${typeof v}`);
  }
  if (!VALID_KINDS.has(v as MessageKind)) {
    throw new MailParseError(path, `invalid kind: ${v}`);
  }
  return v as MessageKind;
}

function validDeliveryStatus(
  v: unknown,
  path: string
): DeliveryStatus | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw new MailParseError(path, `invalid delivery_status type: ${typeof v}`);
  }
  if (!VALID_DELIVERY_STATUSES.has(v as DeliveryStatus)) {
    throw new MailParseError(path, `invalid delivery_status: ${v}`);
  }
  return v as DeliveryStatus;
}

function validDraftStatus(
  v: unknown,
  path: string
): DraftStatus | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw new MailParseError(path, `invalid draft_status type: ${typeof v}`);
  }
  if (!VALID_DRAFT_STATUSES.has(v as DraftStatus)) {
    throw new MailParseError(path, `invalid draft_status: ${v}`);
  }
  return v as DraftStatus;
}

function validMetadata(
  v: unknown,
  path: string
): Record<string, unknown> | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new MailParseError(path, `metadata must be an object`);
  }
  return v as Record<string, unknown>;
}

/**
 * Small content-type mapping for common attachment types. Returns null
 * on unknown extensions — the HTTP stream route falls back to
 * `application/octet-stream`.
 */
function guessContentType(filename: string): string | null {
  const ext = extname(filename).toLowerCase();
  switch (ext) {
    case ".md":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    case ".json":
      return "application/json";
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".html":
    case ".htm":
      return "text/html";
    case ".csv":
      return "text/csv";
    default:
      return null;
  }
}

export function assertAbsolute(path: string, label: string): string {
  if (!isAbsolute(path)) {
    throw new Error(`${label} must be absolute: ${path}`);
  }
  return path;
}
