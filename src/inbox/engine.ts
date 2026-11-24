/**
 * Phase 4.4a InboxEngine.
 *
 * Wraps the shared bun:sqlite handle (from MemoryEngine.getDb()) plus
 * the agent's local `mail_root` filesystem. Files on disk are the
 * source of truth; the engine writes files on send/draft/state
 * transitions, and the projector (separate module) reads files +
 * upserts rows. Read methods here go to SQL.
 *
 * Invariant: every row (`inbox_messages`, `outbox_messages`,
 * `inbox_drafts`, `inbox_attachments`) has `owner_agent_id` = THIS
 * spindle's agent id. Cross-spindle visibility is 4.4b's problem.
 */

import { Database } from "bun:sqlite";
import type { MemoryEngine } from "../memory/engine";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  copyFileSync,
  linkSync,
} from "fs";
import { join, dirname, basename, relative, resolve } from "path";
import {
  discoverMailFiles,
  hashBytes,
  parseMailFile,
  serializeMailFile,
} from "./parse";
import type {
  AgentRoute,
  AgentRouteInput,
  Draft,
  DraftInput,
  DraftListOpts,
  DraftPatch,
  DraftStatus,
  InboxAttachment,
  InboxListOpts,
  InboxMessage,
  InboxSearchOpts,
  InboxStatus,
  InboxStatusSummary,
  MailFrontmatter,
  MessageKind,
  MessagePriority,
  OutboxListOpts,
  OutboxMessage,
  ParsedMailFile,
  ResolvedInboxConfig,
  SendOpts,
  SendResult,
} from "./types";

// ----------------------------------------------------------------------------
// Raw DB row shapes + converters
// ----------------------------------------------------------------------------

interface RawInboxRow {
  id: number;
  message_id: string;
  owner_agent_id: string;
  rel_path: string;
  from_auth: string;
  from_display: string;
  to_agent: string;
  subject: string | null;
  priority: MessagePriority | null;
  kind: MessageKind;
  thread_id: string | null;
  in_reply_to: string | null;
  metadata_json: string | null;
  body: string;
  status: InboxStatus;
  date_iso: string;
  date_ms: number;
  file_mtime: number;
  file_sha256: string;
  projected_at: number;
}

interface RawAttachmentRow {
  id: number;
  message_id: string;
  filename: string;
  rel_path: string;
  content_type: string | null;
  size_bytes: number;
  sha256: string;
}

interface RawOutboxRow {
  id: string;
  owner_agent_id: string;
  rel_path: string;
  to_agent: string;
  to_mail_root: string;
  from_display: string;
  subject: string | null;
  body: string;
  kind: MessageKind;
  thread_id: string | null;
  sent_at_iso: string;
  sent_at_ms: number;
  delivery_status: "delivered" | "unrouted" | "failed";
  delivery_error: string | null;
  file_mtime: number;
  file_sha256: string;
  projected_at: number;
}

interface RawDraftRow {
  id: string;
  owner_agent_id: string;
  rel_path: string;
  to_agent: string | null;
  from_display: string | null;
  subject: string | null;
  body: string;
  priority: MessagePriority | null;
  kind: MessageKind;
  metadata_json: string | null;
  author_auth: string;
  status: DraftStatus;
  created_at_iso: string;
  updated_at_iso: string;
  created_at_ms: number;
  updated_at_ms: number;
  file_mtime: number;
  file_sha256: string;
  projected_at: number;
}

interface RawRouteRow {
  agent_id: string;
  mail_root: string;
  display_name: string;
  avatar_path: string | null;
  capabilities: string | null;
  last_seen_at: number | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

function rowToInbox(r: RawInboxRow, attachments: InboxAttachment[]): InboxMessage {
  return {
    id: r.message_id,
    ownerAgentId: r.owner_agent_id,
    relPath: r.rel_path,
    fromAuth: r.from_auth,
    fromDisplay: r.from_display,
    toAgent: r.to_agent,
    subject: r.subject,
    priority: r.priority,
    kind: r.kind,
    threadId: r.thread_id,
    inReplyTo: r.in_reply_to,
    metadata: r.metadata_json ? (JSON.parse(r.metadata_json) as Record<string, unknown>) : null,
    body: r.body,
    status: r.status,
    dateIso: r.date_iso,
    dateMs: r.date_ms,
    fileMtime: r.file_mtime,
    fileSha256: r.file_sha256,
    projectedAt: r.projected_at,
    attachments,
  };
}

function rowToAttachment(r: RawAttachmentRow): InboxAttachment {
  return {
    id: r.id,
    messageId: r.message_id,
    filename: r.filename,
    relPath: r.rel_path,
    contentType: r.content_type,
    sizeBytes: r.size_bytes,
    sha256: r.sha256,
  };
}

function rowToOutbox(r: RawOutboxRow): OutboxMessage {
  return {
    id: r.id,
    ownerAgentId: r.owner_agent_id,
    relPath: r.rel_path,
    toAgent: r.to_agent,
    toMailRoot: r.to_mail_root,
    fromDisplay: r.from_display,
    subject: r.subject,
    body: r.body,
    kind: r.kind,
    threadId: r.thread_id,
    sentAtIso: r.sent_at_iso,
    sentAtMs: r.sent_at_ms,
    deliveryStatus: r.delivery_status,
    deliveryError: r.delivery_error,
    fileMtime: r.file_mtime,
    fileSha256: r.file_sha256,
    projectedAt: r.projected_at,
  };
}

function rowToDraft(r: RawDraftRow): Draft {
  return {
    id: r.id,
    ownerAgentId: r.owner_agent_id,
    relPath: r.rel_path,
    toAgent: r.to_agent,
    fromDisplay: r.from_display,
    subject: r.subject,
    body: r.body,
    priority: r.priority,
    kind: r.kind,
    metadata: r.metadata_json ? (JSON.parse(r.metadata_json) as Record<string, unknown>) : null,
    authorAuth: r.author_auth,
    status: r.status,
    createdAtIso: r.created_at_iso,
    updatedAtIso: r.updated_at_iso,
    createdAtMs: r.created_at_ms,
    updatedAtMs: r.updated_at_ms,
    fileMtime: r.file_mtime,
    fileSha256: r.file_sha256,
    projectedAt: r.projected_at,
  };
}

function rowToRoute(r: RawRouteRow): AgentRoute {
  return {
    agentId: r.agent_id,
    mailRoot: r.mail_root,
    displayName: r.display_name,
    avatarPath: r.avatar_path,
    capabilities: r.capabilities ? (JSON.parse(r.capabilities) as string[]) : null,
    lastSeenAt: r.last_seen_at,
    createdBy: r.created_by as AgentRoute["createdBy"],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ----------------------------------------------------------------------------
// InboxEngine
// ----------------------------------------------------------------------------

export interface InboxEngineOpenOpts {
  /** Memory engine — used only for its DB handle. */
  memory: MemoryEngine;
  /** Resolved inbox config for THIS spindle. */
  config: ResolvedInboxConfig;
  /** Override now() in tests for deterministic timestamps. */
  nowFn?: () => number;
}

export class InboxEngine {
  private readonly db: Database;
  private readonly ownerAgentId: string;
  private readonly ownerDisplayName: string;
  private readonly mailRoot: string;
  private readonly operatorMailRoot: string;
  private readonly now: () => number;
  private closed = false;

  private constructor(
    db: Database,
    ownerAgentId: string,
    ownerDisplayName: string,
    mailRoot: string,
    operatorMailRoot: string,
    nowFn: () => number
  ) {
    this.db = db;
    this.ownerAgentId = ownerAgentId;
    this.ownerDisplayName = ownerDisplayName;
    this.mailRoot = mailRoot;
    this.operatorMailRoot = operatorMailRoot;
    this.now = nowFn;
  }

  static async open(opts: InboxEngineOpenOpts): Promise<InboxEngine> {
    const db = opts.memory.getDb();
    const cfg = opts.config;
    const nowFn = opts.nowFn ?? (() => Date.now());
    const engine = new InboxEngine(
      db,
      cfg.agentId,
      cfg.agentDisplayName,
      cfg.mailRoot,
      cfg.operatorMailRoot,
      nowFn
    );
    engine.ensureMailRoot(cfg.mailRoot);
    engine.ensureMailRoot(cfg.operatorMailRoot);
    engine.seedReservedRoutes();
    for (const contact of cfg.contacts) {
      engine.upsertRoute({ ...contact, createdBy: contact.createdBy ?? "config" });
    }
    return engine;
  }

  close(): void {
    this.closed = true;
    // Does NOT close db — MemoryEngine owns the handle and closes it.
  }

  getOwnerAgentId(): string {
    return this.ownerAgentId;
  }

  getMailRoot(): string {
    return this.mailRoot;
  }

  getOperatorMailRoot(): string {
    return this.operatorMailRoot;
  }

  /**
   * Build out the standard `mail/inbox,read,tombstoned / outbox / drafts`
   * directory tree if it doesn't already exist. Idempotent.
   */
  private ensureMailRoot(root: string): void {
    for (const sub of [
      "inbox",
      "inbox/read",
      "inbox/tombstoned",
      "outbox",
      "drafts",
    ]) {
      mkdirSync(join(root, sub), { recursive: true });
    }
  }

  // ==========================================================================
  // Routing table
  // ==========================================================================

  /** Seed `self` + `operator` rows. Idempotent. */
  private seedReservedRoutes(): void {
    this.upsertRoute({
      agentId: "self",
      mailRoot: this.mailRoot,
      displayName: this.ownerDisplayName,
      createdBy: "self",
    });
    this.upsertRoute({
      agentId: this.ownerAgentId,
      mailRoot: this.mailRoot,
      displayName: this.ownerDisplayName,
      createdBy: "self",
    });
    this.upsertRoute({
      agentId: "operator",
      mailRoot: this.operatorMailRoot,
      displayName: "Operator",
      createdBy: "auto",
    });
  }

  listRoutes(): AgentRoute[] {
    this.assertOpen();
    const rows = this.db
      .query<RawRouteRow, []>(
        `SELECT * FROM agent_routes ORDER BY agent_id ASC`
      )
      .all();
    return rows.map(rowToRoute);
  }

  getRoute(agentId: string): AgentRoute | null {
    this.assertOpen();
    const row = this.db
      .query<RawRouteRow, [string]>(
        `SELECT * FROM agent_routes WHERE agent_id = ?`
      )
      .get(agentId);
    return row ? rowToRoute(row) : null;
  }

  /**
   * Resolve the route used for a send. Accepts "self" (alias) and the
   * spindle's own agent id interchangeably. Returns null when the id
   * isn't in the routing table — caller falls through to operator.
   */
  resolveRoute(agentId: string): AgentRoute | null {
    if (agentId === "self") {
      return this.getRoute(this.ownerAgentId) ?? this.getRoute("self");
    }
    return this.getRoute(agentId);
  }

  upsertRoute(input: AgentRouteInput): AgentRoute {
    this.assertOpen();
    const now = this.now();
    const expanded = expandPath(input.mailRoot);
    const capabilities = input.capabilities
      ? JSON.stringify(input.capabilities)
      : null;
    const createdBy = input.createdBy ?? "operator";
    // UPSERT on (agent_id) — preserve created_at + created_by on update.
    this.db.run(
      `INSERT INTO agent_routes (
        agent_id, mail_root, display_name, avatar_path, capabilities,
        last_seen_at, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        mail_root = excluded.mail_root,
        display_name = excluded.display_name,
        avatar_path = excluded.avatar_path,
        capabilities = excluded.capabilities,
        updated_at = excluded.updated_at`,
      [
        input.agentId,
        expanded,
        input.displayName,
        input.avatarPath ?? null,
        capabilities,
        createdBy,
        now,
        now,
      ]
    );
    return this.getRoute(input.agentId)!;
  }

  deleteRoute(agentId: string): boolean {
    this.assertOpen();
    if (agentId === "self" || agentId === "operator" || agentId === this.ownerAgentId) {
      // Reserved. Deletion not supported — operator would silently lose routing.
      throw new Error(`cannot delete reserved route: ${agentId}`);
    }
    const existing = this.getRoute(agentId);
    if (!existing) return false;
    this.db.run(`DELETE FROM agent_routes WHERE agent_id = ?`, [agentId]);
    return true;
  }

  /**
   * Bump last_seen_at on a route — called by the projector when an
   * inbox message with `from_auth='agent:<id>'` arrives, so the
   * routing table reflects which contacts are live.
   */
  touchRouteLastSeen(agentId: string, at: number = this.now()): void {
    this.assertOpen();
    this.db.run(
      `UPDATE agent_routes SET last_seen_at = ?, updated_at = ? WHERE agent_id = ?`,
      [at, at, agentId]
    );
  }

  // ==========================================================================
  // Send (agent- or operator-initiated)
  // ==========================================================================

  send(opts: SendOpts): SendResult {
    this.assertOpen();
    const now = opts.now ?? this.now();
    const route = this.resolveRoute(opts.to);
    const targetAgent = route?.agentId ?? "operator";
    const targetMailRoot = route?.mailRoot ?? this.operatorMailRoot;
    const unrouted = !route;
    const deliveryStatus = unrouted ? "unrouted" : "delivered";

    // Build the stable id.
    const id = opts.idOverride ?? this.generateMessageId(opts.from, opts.subject, now);

    // Assemble frontmatter — delivered copy and outbox copy share the
    // same shape; the outbox copy's frontmatter carries the delivery
    // metadata so an operator inspecting the file sees what happened.
    const kind: MessageKind = opts.kind ?? "message";
    const sharedFm: MailFrontmatter = {
      id,
      from_auth: opts.fromAuth,
      from: opts.from,
      to: opts.to,
      subject: opts.subject,
      date: new Date(now).toISOString(),
      priority: opts.priority,
      kind,
      thread_id: opts.threadId,
      in_reply_to: opts.inReplyTo,
      metadata: unrouted
        ? { ...(opts.metadata ?? {}), original_recipient: opts.to }
        : opts.metadata,
    };
    const deliveredFm: MailFrontmatter = { ...sharedFm };
    const outboxFm: MailFrontmatter = {
      ...sharedFm,
      delivery_status: deliveryStatus,
      to_mail_root: targetMailRoot,
    };

    const deliveredBytes = serializeMailFile(deliveredFm, opts.body);
    const outboxBytes = serializeMailFile(outboxFm, opts.body);

    // Write delivered copy into target mailbox.
    const hasAttachments = !!opts.attachments && opts.attachments.length > 0;
    const targetInboxDir = join(targetMailRoot, "inbox");
    mkdirSync(targetInboxDir, { recursive: true });
    let deliveredRel: string;
    let deliveredAbs: string;
    if (hasAttachments) {
      const msgDir = join(targetInboxDir, id);
      mkdirSync(msgDir, { recursive: true });
      deliveredAbs = join(msgDir, "message.md");
      atomicWrite(deliveredAbs, deliveredBytes);
      for (const att of opts.attachments!) {
        const destName = safeAttachmentName(att.filename, msgDir);
        copyFileSync(att.sourceAbsPath, join(msgDir, destName));
      }
      deliveredRel = relative(targetMailRoot, deliveredAbs);
    } else {
      deliveredAbs = join(targetInboxDir, `${id}.md`);
      atomicWrite(deliveredAbs, deliveredBytes);
      deliveredRel = relative(targetMailRoot, deliveredAbs);
    }

    // Write retained outbox copy to THIS spindle's outbox.
    let outboxRetained = false;
    let outboxRelPath: string | null = null;
    try {
      const outboxDir = join(this.mailRoot, "outbox");
      mkdirSync(outboxDir, { recursive: true });
      if (hasAttachments) {
        const outMsgDir = join(outboxDir, id);
        mkdirSync(outMsgDir, { recursive: true });
        const outAbs = join(outMsgDir, "message.md");
        atomicWrite(outAbs, outboxBytes);
        for (const att of opts.attachments!) {
          const destName = safeAttachmentName(att.filename, outMsgDir);
          const destAbs = join(outMsgDir, destName);
          // Try hardlink first (cheap) — fall back to copy across devices.
          try {
            linkSync(join(dirname(deliveredAbs), destName), destAbs);
          } catch {
            copyFileSync(att.sourceAbsPath, destAbs);
          }
        }
        outboxRelPath = relative(this.mailRoot, outAbs);
      } else {
        const outAbs = join(outboxDir, `${id}.md`);
        atomicWrite(outAbs, outboxBytes);
        outboxRelPath = relative(this.mailRoot, outAbs);
      }
      outboxRetained = true;
    } catch (err) {
      // Delivery still succeeded — just no local record. Log via console;
      // the projector will also not find an outbox file so the DB state
      // is consistent with the filesystem.
      console.warn(
        `[inbox] outbox retention failed for ${id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const availableRoutes = unrouted
      ? this.listRoutes()
          .filter(
            (r) =>
              r.agentId !== "self" &&
              r.agentId !== "operator" &&
              r.agentId !== this.ownerAgentId
          )
          .map((r) => ({
            agentId: r.agentId,
            displayName: r.displayName,
            capabilities: r.capabilities,
          }))
      : undefined;

    return {
      messageId: id,
      relPath: deliveredRel,
      deliveryStatus,
      deliveryError: null,
      deliveredTo: targetAgent,
      deliveredMailRoot: targetMailRoot,
      outboxRetained,
      outboxRelPath,
      ...(availableRoutes ? { availableRoutes } : {}),
    };
  }

  /**
   * Generate a stable id: `{YYYY-MM-DD}-{from-slug}-{subject-slug}-{hex4}`.
   * The hex suffix is random; collision-on-upsert is retried by caller.
   */
  private generateMessageId(
    from: string,
    subject: string | undefined,
    now: number
  ): string {
    const date = new Date(now).toISOString().slice(0, 10);
    const fromSlug = slugify(from) || "sender";
    // Strip Re:/Fwd: prefixes before slugifying so thread replies
    // don't accumulate "re-re-re-re" in the filename
    const cleanSubject = subject
      ? subject.replace(/^(re|fwd|fw):\s*/gi, "").trim()
      : "";
    const subjSlug = cleanSubject ? slugify(cleanSubject) : "";
    const base = subjSlug ? `${date}-${fromSlug}-${subjSlug}` : `${date}-${fromSlug}`;
    const hex = Math.floor(Math.random() * 0x10000)
      .toString(16)
      .padStart(4, "0");
    return `${base}-${hex}`;
  }

  // ==========================================================================
  // State transitions (file move + DB update)
  // ==========================================================================

  markRead(messageId: string): InboxMessage | null {
    return this.transitionInbox(messageId, "unread", "read");
  }

  markUnread(messageId: string): InboxMessage | null {
    return this.transitionInbox(messageId, "read", "unread");
  }

  tombstone(messageId: string, reason?: string): InboxMessage | null {
    const row = this.getInboxRowByMessageId(messageId);
    if (!row || row.status === "tombstoned") return null;
    const movedRelPath = moveInboxFile(
      this.mailRoot,
      row.rel_path,
      "tombstoned"
    );
    // Merge reason into the existing metadata map rather than composing
    // json-patch in SQL (SQLite has json_set but not json_patch; working
    // at the JS layer keeps the SQL simple).
    const existingMeta =
      row.metadata_json != null
        ? (JSON.parse(row.metadata_json) as Record<string, unknown>)
        : {};
    const mergedMeta = {
      ...existingMeta,
      tombstone_reason: reason ?? "operator:web-ui",
      tombstoned_at: new Date(this.now()).toISOString(),
    };
    const now = this.now();
    this.db.run(
      `UPDATE inbox_messages
         SET status = 'tombstoned',
             rel_path = ?,
             metadata_json = ?,
             projected_at = ?
       WHERE message_id = ?`,
      [movedRelPath, JSON.stringify(mergedMeta), now, messageId]
    );
    return this.getMessage(messageId);
  }

  restoreTombstoned(messageId: string): InboxMessage | null {
    const row = this.getInboxRowByMessageId(messageId);
    if (!row || row.status !== "tombstoned") return null;
    const movedRelPath = moveInboxFile(this.mailRoot, row.rel_path, "inbox");
    const now = this.now();
    this.db.run(
      `UPDATE inbox_messages
         SET status = 'unread', rel_path = ?, projected_at = ?
       WHERE message_id = ?`,
      [movedRelPath, now, messageId]
    );
    return this.getMessage(messageId);
  }

  private transitionInbox(
    messageId: string,
    fromStatus: InboxStatus,
    toStatus: InboxStatus
  ): InboxMessage | null {
    const row = this.getInboxRowByMessageId(messageId);
    if (!row || row.status !== fromStatus) return null;
    const movedRelPath = moveInboxFile(
      this.mailRoot,
      row.rel_path,
      toStatus === "read" ? "read" : toStatus === "unread" ? "inbox" : "tombstoned"
    );
    const now = this.now();
    this.db.run(
      `UPDATE inbox_messages
         SET status = ?, rel_path = ?, projected_at = ?
       WHERE message_id = ?`,
      [toStatus, movedRelPath, now, messageId]
    );
    return this.getMessage(messageId);
  }

  // ==========================================================================
  // Draft lifecycle
  // ==========================================================================

  saveDraft(input: DraftInput): Draft {
    this.assertOpen();
    const now = this.now();
    const id = input.idOverride ?? this.generateMessageId(
      input.from ?? "draft",
      input.subject ?? undefined,
      now
    );
    const kind: MessageKind = input.kind ?? "message";
    const fm: MailFrontmatter = {
      id,
      from_auth: input.fromAuth,
      from: input.from ?? "",
      to: input.to ?? undefined,
      subject: input.subject ?? undefined,
      date: new Date(now).toISOString(),
      priority: input.priority ?? undefined,
      kind,
      metadata: input.metadata ?? undefined,
      draft_status: "draft",
    };
    const bytes = serializeMailFile(fm, input.body);
    const draftsDir = join(this.mailRoot, "drafts");
    mkdirSync(draftsDir, { recursive: true });
    const abs = join(draftsDir, `${id}.md`);
    atomicWrite(abs, bytes);
    const relPath = relative(this.mailRoot, abs);
    const sha = hashBytes(readFileSync(abs));
    const mtime = statSync(abs).mtimeMs;
    this.db.run(
      `INSERT INTO inbox_drafts (
        id, owner_agent_id, rel_path, to_agent, from_display,
        subject, body, priority, kind, metadata_json, author_auth,
        status, created_at_iso, updated_at_iso,
        created_at_ms, updated_at_ms,
        file_mtime, file_sha256, projected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        this.ownerAgentId,
        relPath,
        input.to ?? null,
        input.from ?? null,
        input.subject ?? null,
        input.body,
        input.priority ?? null,
        kind,
        input.metadata ? JSON.stringify(input.metadata) : null,
        input.fromAuth,
        "draft",
        new Date(now).toISOString(),
        new Date(now).toISOString(),
        now,
        now,
        mtime,
        sha,
        now,
      ]
    );
    return this.getDraft(id)!;
  }

  updateDraft(id: string, patch: DraftPatch): Draft | null {
    this.assertOpen();
    const existing = this.getDraft(id);
    if (!existing) return null;

    const next: DraftInput = {
      to: patch.to !== undefined ? patch.to : existing.toAgent,
      from: patch.from !== undefined ? patch.from : existing.fromDisplay,
      fromAuth: existing.authorAuth,
      subject: patch.subject !== undefined ? patch.subject : existing.subject,
      body: patch.body !== undefined ? patch.body : existing.body,
      priority: patch.priority !== undefined ? patch.priority : existing.priority,
      kind: patch.kind !== undefined ? patch.kind : existing.kind,
      metadata: patch.metadata !== undefined ? patch.metadata : existing.metadata,
      idOverride: id,
    };
    const status: DraftStatus = patch.status ?? existing.status;
    const now = this.now();
    const fm: MailFrontmatter = {
      id,
      from_auth: existing.authorAuth,
      from: next.from ?? "",
      to: next.to ?? undefined,
      subject: next.subject ?? undefined,
      date: existing.createdAtIso,
      priority: next.priority ?? undefined,
      kind: next.kind ?? "message",
      metadata: next.metadata ?? undefined,
      draft_status: status,
    };
    const bytes = serializeMailFile(fm, next.body);
    const abs = join(this.mailRoot, existing.relPath);
    atomicWrite(abs, bytes);
    const sha = hashBytes(readFileSync(abs));
    const mtime = statSync(abs).mtimeMs;
    this.db.run(
      `UPDATE inbox_drafts SET
         to_agent = ?, from_display = ?, subject = ?, body = ?,
         priority = ?, kind = ?, metadata_json = ?, status = ?,
         updated_at_iso = ?, updated_at_ms = ?,
         file_mtime = ?, file_sha256 = ?, projected_at = ?
       WHERE id = ?`,
      [
        next.to ?? null,
        next.from ?? null,
        next.subject ?? null,
        next.body,
        next.priority ?? null,
        next.kind ?? "message",
        next.metadata ? JSON.stringify(next.metadata) : null,
        status,
        new Date(now).toISOString(),
        now,
        mtime,
        sha,
        now,
        id,
      ]
    );
    return this.getDraft(id);
  }

  sendDraft(id: string, fromAuth?: string): SendResult | null {
    this.assertOpen();
    const draft = this.getDraft(id);
    if (!draft) return null;
    if (!draft.toAgent || draft.toAgent.length === 0) {
      throw new Error(`draft ${id} has no recipient — set 'to' before sending`);
    }
    // If the draft accumulated attachments, pass them through. Files live
    // in drafts/{id}/ alongside message.md; the engine's send flow reads
    // them by absolute path and writes into the recipient's mail dir.
    const atts = this.listDraftAttachments(id);
    const attachments = atts.map((a) => ({
      filename: a.filename,
      sourceAbsPath: join(this.mailRoot, a.relPath),
      contentType: a.contentType ?? undefined,
    }));
    const result = this.send({
      to: draft.toAgent,
      from: draft.fromDisplay ?? "",
      fromAuth: fromAuth ?? draft.authorAuth,
      subject: draft.subject ?? undefined,
      body: draft.body,
      priority: draft.priority ?? undefined,
      kind: draft.kind,
      metadata: draft.metadata ?? undefined,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
    this.cancelDraft(id);
    return result;
  }

  cancelDraft(id: string): boolean {
    this.assertOpen();
    const draft = this.getDraft(id);
    if (!draft) return false;
    const abs = join(this.mailRoot, draft.relPath);
    if (existsSync(abs)) rmSync(abs);
    // If it was a multi-file draft, nuke the whole dir (attachments too).
    const draftDir = join(this.mailRoot, "drafts", id);
    if (existsSync(draftDir)) rmSync(draftDir, { recursive: true, force: true });
    this.db.run(`DELETE FROM inbox_drafts WHERE id = ?`, [id]);
    return true;
  }

  // ==========================================================================
  // Draft attachments (Phase 4.4c)
  // ==========================================================================

  /**
   * Materialize the draft-dir layout if this draft is currently stored
   * as a bare `{id}.md` file. Required before adding attachments.
   * Returns the absolute path of message.md in the dir layout.
   */
  private ensureDraftDir(id: string): string {
    const draft = this.getDraft(id);
    if (!draft) throw new Error(`draft not found: ${id}`);
    const dir = join(this.mailRoot, "drafts", id);
    const dirMessageAbs = join(dir, "message.md");
    if (draft.relPath === `drafts/${id}/message.md`) {
      // Already dir layout.
      mkdirSync(dir, { recursive: true });
      return dirMessageAbs;
    }
    // Currently `drafts/{id}.md` — convert.
    const bareAbs = join(this.mailRoot, draft.relPath);
    if (!existsSync(bareAbs)) {
      throw new Error(`draft file missing: ${bareAbs}`);
    }
    mkdirSync(dir, { recursive: true });
    renameSync(bareAbs, dirMessageAbs);
    const newRel = `drafts/${id}/message.md`;
    this.db.run(
      `UPDATE inbox_drafts SET rel_path = ?, projected_at = ? WHERE id = ?`,
      [newRel, this.now(), id]
    );
    return dirMessageAbs;
  }

  addDraftAttachment(
    id: string,
    filename: string,
    bytes: Buffer,
    _contentType?: string
  ): { filename: string; sizeBytes: number; sha256: string; relPath: string } {
    this.assertOpen();
    const draft = this.getDraft(id);
    if (!draft) throw new Error(`draft not found: ${id}`);
    this.ensureDraftDir(id);
    const dir = join(this.mailRoot, "drafts", id);
    const safeName = safeAttachmentName(filename, dir);
    const absPath = join(dir, safeName);
    writeFileSync(absPath, bytes);
    this.db.run(
      `UPDATE inbox_drafts SET updated_at_ms = ?, projected_at = ? WHERE id = ?`,
      [this.now(), this.now(), id]
    );
    return {
      filename: safeName,
      sizeBytes: bytes.length,
      sha256: hashBytes(bytes),
      relPath: `drafts/${id}/${safeName}`,
    };
  }

  listDraftAttachments(
    id: string
  ): Array<{ filename: string; sizeBytes: number; contentType: string | null; relPath: string }> {
    this.assertOpen();
    const draft = this.getDraft(id);
    if (!draft) return [];
    const dir = join(this.mailRoot, "drafts", id);
    if (!existsSync(dir)) return [];
    // Lazy import of readdir so this module stays tight.
    const fsMod = require("fs") as typeof import("fs");
    return fsMod
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name !== "message.md")
      .map((e) => {
        const abs = join(dir, e.name);
        const st = fsMod.statSync(abs);
        return {
          filename: e.name,
          sizeBytes: st.size,
          contentType: guessContentTypeFromExt(e.name),
          relPath: `drafts/${id}/${e.name}`,
        };
      });
  }

  removeDraftAttachment(id: string, filename: string): boolean {
    this.assertOpen();
    const dir = join(this.mailRoot, "drafts", id);
    const abs = join(dir, filename);
    // Only allow names inside the draft dir — defend against "../../" input.
    if (filename.includes("/") || filename.includes("..")) {
      throw new Error(`invalid attachment name: ${filename}`);
    }
    if (!existsSync(abs)) return false;
    rmSync(abs);
    this.db.run(
      `UPDATE inbox_drafts SET updated_at_ms = ?, projected_at = ? WHERE id = ?`,
      [this.now(), this.now(), id]
    );
    return true;
  }

  // ==========================================================================
  // Reads
  // ==========================================================================

  getMessage(messageId: string): InboxMessage | null {
    this.assertOpen();
    const row = this.getInboxRowByMessageId(messageId);
    if (!row) return null;
    const attachments = this.getAttachmentsForMessage(messageId);
    return rowToInbox(row, attachments);
  }

  listInbox(opts: InboxListOpts = {}): { items: InboxMessage[]; total: number } {
    this.assertOpen();
    const { limit, offset } = clampPagination(opts);
    const status = opts.status ?? "unread";
    const where: string[] = [`owner_agent_id = ?`];
    const params: Array<string | number> = [this.ownerAgentId];
    if (status !== "all") {
      where.push(`status = ?`);
      params.push(status);
    }
    if (opts.kind && opts.kind.length > 0) {
      const ph = opts.kind.map(() => "?").join(", ");
      where.push(`kind IN (${ph})`);
      for (const k of opts.kind) params.push(k);
    }
    if (opts.priority && opts.priority.length > 0) {
      const ph = opts.priority.map(() => "?").join(", ");
      where.push(`priority IN (${ph})`);
      for (const p of opts.priority) params.push(p);
    }
    if (opts.threadId) {
      where.push(`thread_id = ?`);
      params.push(opts.threadId);
    }
    if (opts.from) {
      where.push(`from_display = ?`);
      params.push(opts.from);
    }

    const whereSql = where.join(" AND ");
    const total = (
      this.db
        .query<{ c: number }, (string | number)[]>(
          `SELECT COUNT(*) AS c FROM inbox_messages WHERE ${whereSql}`
        )
        .get(...params)
    )?.c ?? 0;
    const rows = this.db
      .query<RawInboxRow, (string | number)[]>(
        `SELECT * FROM inbox_messages
           WHERE ${whereSql}
           ORDER BY date_ms DESC
           LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset);
    const ids = rows.map((r) => r.message_id);
    const attsByMsg = this.getAttachmentsForMessages(ids);
    const items = rows.map((r) => rowToInbox(r, attsByMsg.get(r.message_id) ?? []));
    return { items, total };
  }

  searchInbox(opts: InboxSearchOpts): { items: InboxMessage[]; total: number } {
    this.assertOpen();
    const { limit, offset } = clampPagination(opts);
    const ftsQuery = escapeFts(opts.q);
    if (ftsQuery.length === 0) return { items: [], total: 0 };
    const status = opts.status ?? "all";
    const where: string[] = [
      `m.owner_agent_id = ?`,
      `inbox_messages_fts MATCH ?`,
    ];
    const params: Array<string | number> = [this.ownerAgentId, ftsQuery];
    if (status !== "all") {
      where.push(`m.status = ?`);
      params.push(status);
    }
    const whereSql = where.join(" AND ");
    const total = (
      this.db
        .query<{ c: number }, (string | number)[]>(
          `SELECT COUNT(*) AS c
             FROM inbox_messages m
             JOIN inbox_messages_fts f ON f.rowid = m.id
             WHERE ${whereSql}`
        )
        .get(...params)
    )?.c ?? 0;
    const rows = this.db
      .query<RawInboxRow, (string | number)[]>(
        `SELECT m.* FROM inbox_messages m
           JOIN inbox_messages_fts f ON f.rowid = m.id
           WHERE ${whereSql}
           ORDER BY rank, m.date_ms DESC
           LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset);
    const ids = rows.map((r) => r.message_id);
    const attsByMsg = this.getAttachmentsForMessages(ids);
    const items = rows.map((r) => rowToInbox(r, attsByMsg.get(r.message_id) ?? []));
    return { items, total };
  }

  getInboxStatus(): InboxStatusSummary {
    this.assertOpen();
    const unreadRow = this.db
      .query<{ c: number }, [string]>(
        `SELECT COUNT(*) AS c FROM inbox_messages
           WHERE owner_agent_id = ? AND status = 'unread'`
      )
      .get(this.ownerAgentId);
    const unreadCount = unreadRow?.c ?? 0;
    const sendersRows = this.db
      .query<{ from_display: string }, [string]>(
        `SELECT DISTINCT from_display FROM inbox_messages
           WHERE owner_agent_id = ? AND status = 'unread'
           ORDER BY from_display ASC`
      )
      .all(this.ownerAgentId);
    const priorityRow = this.db
      .query<{ c: number }, [string]>(
        `SELECT COUNT(*) AS c FROM inbox_messages
           WHERE owner_agent_id = ? AND status = 'unread'
             AND (priority = 'high' OR priority = 'urgent')`
      )
      .get(this.ownerAgentId);
    return {
      unreadCount,
      unreadSenders: sendersRows.map((r) => r.from_display),
      hasPriority: (priorityRow?.c ?? 0) > 0,
    };
  }

  listOutbox(opts: OutboxListOpts = {}): { items: OutboxMessage[]; total: number } {
    this.assertOpen();
    const { limit, offset } = clampPagination(opts);
    const where: string[] = [`owner_agent_id = ?`];
    const params: Array<string | number> = [this.ownerAgentId];
    if (opts.deliveryStatus && opts.deliveryStatus.length > 0) {
      const ph = opts.deliveryStatus.map(() => "?").join(", ");
      where.push(`delivery_status IN (${ph})`);
      for (const s of opts.deliveryStatus) params.push(s);
    }
    const whereSql = where.join(" AND ");
    const total = (
      this.db
        .query<{ c: number }, (string | number)[]>(
          `SELECT COUNT(*) AS c FROM outbox_messages WHERE ${whereSql}`
        )
        .get(...params)
    )?.c ?? 0;
    const rows = this.db
      .query<RawOutboxRow, (string | number)[]>(
        `SELECT * FROM outbox_messages
           WHERE ${whereSql}
           ORDER BY sent_at_ms DESC
           LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset);
    return { items: rows.map(rowToOutbox), total };
  }

  getOutboxMessage(id: string): OutboxMessage | null {
    this.assertOpen();
    const row = this.db
      .query<RawOutboxRow, [string, string]>(
        `SELECT * FROM outbox_messages WHERE id = ? AND owner_agent_id = ?`
      )
      .get(id, this.ownerAgentId);
    return row ? rowToOutbox(row) : null;
  }

  listDrafts(opts: DraftListOpts = {}): { items: Draft[]; total: number } {
    this.assertOpen();
    const { limit, offset } = clampPagination(opts);
    const where: string[] = [`owner_agent_id = ?`];
    const params: Array<string | number> = [this.ownerAgentId];
    if (opts.status) {
      where.push(`status = ?`);
      params.push(opts.status);
    }
    const whereSql = where.join(" AND ");
    const total = (
      this.db
        .query<{ c: number }, (string | number)[]>(
          `SELECT COUNT(*) AS c FROM inbox_drafts WHERE ${whereSql}`
        )
        .get(...params)
    )?.c ?? 0;
    const rows = this.db
      .query<RawDraftRow, (string | number)[]>(
        `SELECT * FROM inbox_drafts
           WHERE ${whereSql}
           ORDER BY updated_at_ms DESC
           LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset);
    return { items: rows.map(rowToDraft), total };
  }

  getDraft(id: string): Draft | null {
    this.assertOpen();
    const row = this.db
      .query<RawDraftRow, [string, string]>(
        `SELECT * FROM inbox_drafts WHERE id = ? AND owner_agent_id = ?`
      )
      .get(id, this.ownerAgentId);
    return row ? rowToDraft(row) : null;
  }

  getAttachment(attachmentId: number): {
    attachment: InboxAttachment;
    absPath: string;
  } | null {
    this.assertOpen();
    const row = this.db
      .query<RawAttachmentRow, [number, string]>(
        `SELECT a.* FROM inbox_attachments a
           JOIN inbox_messages m ON m.message_id = a.message_id
           WHERE a.id = ? AND m.owner_agent_id = ?`
      )
      .get(attachmentId, this.ownerAgentId);
    if (!row) return null;
    return {
      attachment: rowToAttachment(row),
      absPath: resolve(this.mailRoot, row.rel_path),
    };
  }

  // ==========================================================================
  // Operator mailbox view (shared filesystem, no DB projection).
  //
  // Every spindle on a host defaults to the same operator_mail_root,
  // so the messages there belong to a single logical operator — but
  // multiple spindles may be competing to project rows into a single
  // SQLite file at once. Instead we read fresh from disk on each call
  // (fine at single-operator scales; Phase 4.4d can introduce a
  // designated-projector model if a real load signal shows up).
  // ==========================================================================

  listOperatorInbox(): OperatorInboxMessage[] {
    this.assertOpen();
    const files = discoverMailFiles(this.operatorMailRoot, {
      include: ["inbox", "inbox/read", "inbox/tombstoned"],
    });
    const items: OperatorInboxMessage[] = [];
    for (const f of files) {
      try {
        const parsed = parseMailFile(f.absPath, this.operatorMailRoot, f.source);
        items.push(parsedToOperatorMessage(parsed));
      } catch {
        // Malformed file — skip quietly; operator can fix on disk.
      }
    }
    // Newest-first by date_ms.
    items.sort((a, b) => b.dateMs - a.dateMs);
    return items;
  }

  getOperatorMessage(messageId: string): OperatorInboxMessage | null {
    const all = this.listOperatorInbox();
    return all.find((m) => m.id === messageId) ?? null;
  }

  getOperatorInboxStatus(): InboxStatusSummary {
    const items = this.listOperatorInbox();
    const unread = items.filter((m) => m.status === "unread");
    const senders = Array.from(new Set(unread.map((m) => m.fromDisplay))).sort();
    const hasPriority = unread.some(
      (m) => m.priority === "high" || m.priority === "urgent"
    );
    return {
      unreadCount: unread.length,
      unreadSenders: senders,
      hasPriority,
    };
  }

  markOperatorRead(messageId: string): OperatorInboxMessage | null {
    return this.transitionOperator(messageId, "unread", "read");
  }

  markOperatorUnread(messageId: string): OperatorInboxMessage | null {
    return this.transitionOperator(messageId, "read", "unread");
  }

  tombstoneOperator(messageId: string): OperatorInboxMessage | null {
    const current = this.getOperatorMessage(messageId);
    if (!current || current.status === "tombstoned") return null;
    moveInboxFile(this.operatorMailRoot, current.relPath, "tombstoned");
    return this.getOperatorMessage(messageId);
  }

  restoreOperator(messageId: string): OperatorInboxMessage | null {
    const current = this.getOperatorMessage(messageId);
    if (!current || current.status !== "tombstoned") return null;
    moveInboxFile(this.operatorMailRoot, current.relPath, "inbox");
    return this.getOperatorMessage(messageId);
  }

  private transitionOperator(
    messageId: string,
    fromStatus: InboxStatus,
    toStatus: InboxStatus
  ): OperatorInboxMessage | null {
    const current = this.getOperatorMessage(messageId);
    if (!current || current.status !== fromStatus) return null;
    const target =
      toStatus === "read" ? "read" : toStatus === "unread" ? "inbox" : "tombstoned";
    moveInboxFile(this.operatorMailRoot, current.relPath, target);
    return this.getOperatorMessage(messageId);
  }

  /**
   * Resolve an operator-inbox attachment's bytes. Since operator
   * messages are not projected into the DB we can't use the existing
   * `inbox_attachments.id → absPath` lookup. Caller supplies the
   * message id + filename; we walk the known message dir.
   */
  getOperatorAttachment(
    messageId: string,
    filename: string
  ): { absPath: string; contentType: string | null; sizeBytes: number } | null {
    if (filename.includes("/") || filename.includes("..")) return null;
    const msg = this.getOperatorMessage(messageId);
    if (!msg) return null;
    const att = msg.attachments.find((a) => a.filename === filename);
    if (!att) return null;
    const abs = join(this.operatorMailRoot, att.relPath);
    if (!existsSync(abs)) return null;
    return {
      absPath: abs,
      contentType: att.contentType,
      sizeBytes: att.sizeBytes,
    };
  }

  // ==========================================================================
  // Projection hooks (called by Projector)
  // ==========================================================================

  /**
   * Upsert one inbox message row from a parsed file. Called by the
   * projector. Also syncs the attachments table. Handles the
   * "to is missing in the file" case by substituting the spindle's
   * own agent id.
   */
  upsertInboxRow(parsed: ParsedMailFile): void {
    this.assertOpen();
    const status: InboxStatus =
      parsed.source === "inbox"
        ? "unread"
        : parsed.source === "inbox/read"
          ? "read"
          : "tombstoned";
    const toAgent = parsed.frontmatter.to ?? this.ownerAgentId;
    const dateIso = parsed.frontmatter.date;
    const dateMs = parseDateMs(dateIso);
    const now = this.now();
    const metadataJson = parsed.frontmatter.metadata
      ? JSON.stringify(parsed.frontmatter.metadata)
      : null;

    // Phase 4.4b: if the sender is an agent with an entry in our
    // routing table, bump its last_seen_at. Signals "peer is live"
    // for the /spindle/routes + future UI surfaces. Non-agent senders
    // (operator:..., unknown) don't count — they have no route row.
    const senderAgentId = parseAgentAuth(parsed.frontmatter.from_auth);
    if (senderAgentId && this.getRoute(senderAgentId)) {
      this.touchRouteLastSeen(senderAgentId, now);
    }

    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO inbox_messages (
          message_id, owner_agent_id, rel_path, from_auth, from_display,
          to_agent, subject, priority, kind, thread_id, in_reply_to,
          metadata_json, body, status, date_iso, date_ms,
          file_mtime, file_sha256, projected_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(message_id) DO UPDATE SET
          rel_path = excluded.rel_path,
          from_auth = excluded.from_auth,
          from_display = excluded.from_display,
          to_agent = excluded.to_agent,
          subject = excluded.subject,
          priority = excluded.priority,
          kind = excluded.kind,
          thread_id = excluded.thread_id,
          in_reply_to = excluded.in_reply_to,
          metadata_json = excluded.metadata_json,
          body = excluded.body,
          status = excluded.status,
          date_iso = excluded.date_iso,
          date_ms = excluded.date_ms,
          file_mtime = excluded.file_mtime,
          file_sha256 = excluded.file_sha256,
          projected_at = excluded.projected_at`,
        [
          parsed.frontmatter.id,
          this.ownerAgentId,
          parsed.relPath,
          parsed.frontmatter.from_auth ?? "unknown",
          parsed.frontmatter.from,
          toAgent,
          parsed.frontmatter.subject ?? null,
          parsed.frontmatter.priority ?? null,
          parsed.frontmatter.kind ?? "message",
          parsed.frontmatter.thread_id ?? null,
          parsed.frontmatter.in_reply_to ?? null,
          metadataJson,
          parsed.body,
          status,
          dateIso,
          dateMs,
          parsed.mtime,
          parsed.sha256,
          now,
        ]
      );
      // Refresh attachments — delete then re-insert. CASCADE would
      // delete via the parent but we want to preserve the row here,
      // so explicit delete.
      this.db.run(
        `DELETE FROM inbox_attachments WHERE message_id = ?`,
        [parsed.frontmatter.id]
      );
      for (const att of parsed.attachments) {
        this.db.run(
          `INSERT INTO inbox_attachments (
            message_id, filename, rel_path, content_type, size_bytes, sha256
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          [
            parsed.frontmatter.id,
            att.filename,
            att.relPath,
            att.contentType,
            att.sizeBytes,
            att.sha256,
          ]
        );
      }
    })();
  }

  upsertOutboxRow(parsed: ParsedMailFile): void {
    this.assertOpen();
    const dateIso = parsed.frontmatter.date;
    const dateMs = parseDateMs(dateIso);
    const now = this.now();
    this.db.run(
      `INSERT INTO outbox_messages (
        id, owner_agent_id, rel_path, to_agent, to_mail_root,
        from_display, subject, body, kind, thread_id,
        sent_at_iso, sent_at_ms, delivery_status, delivery_error,
        file_mtime, file_sha256, projected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        rel_path = excluded.rel_path,
        to_agent = excluded.to_agent,
        to_mail_root = excluded.to_mail_root,
        from_display = excluded.from_display,
        subject = excluded.subject,
        body = excluded.body,
        kind = excluded.kind,
        thread_id = excluded.thread_id,
        sent_at_iso = excluded.sent_at_iso,
        sent_at_ms = excluded.sent_at_ms,
        delivery_status = excluded.delivery_status,
        delivery_error = excluded.delivery_error,
        file_mtime = excluded.file_mtime,
        file_sha256 = excluded.file_sha256,
        projected_at = excluded.projected_at`,
      [
        parsed.frontmatter.id,
        this.ownerAgentId,
        parsed.relPath,
        parsed.frontmatter.to ?? "unknown",
        parsed.frontmatter.to_mail_root ?? "",
        parsed.frontmatter.from,
        parsed.frontmatter.subject ?? null,
        parsed.body,
        parsed.frontmatter.kind ?? "message",
        parsed.frontmatter.thread_id ?? null,
        dateIso,
        dateMs,
        parsed.frontmatter.delivery_status ?? "delivered",
        parsed.frontmatter.delivery_error ?? null,
        parsed.mtime,
        parsed.sha256,
        now,
      ]
    );
  }

  upsertDraftRow(parsed: ParsedMailFile): void {
    this.assertOpen();
    const now = this.now();
    const dateIso = parsed.frontmatter.date;
    const dateMs = parseDateMs(dateIso);
    const metadataJson = parsed.frontmatter.metadata
      ? JSON.stringify(parsed.frontmatter.metadata)
      : null;
    this.db.run(
      `INSERT INTO inbox_drafts (
        id, owner_agent_id, rel_path, to_agent, from_display,
        subject, body, priority, kind, metadata_json, author_auth,
        status, created_at_iso, updated_at_iso,
        created_at_ms, updated_at_ms,
        file_mtime, file_sha256, projected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        rel_path = excluded.rel_path,
        to_agent = excluded.to_agent,
        from_display = excluded.from_display,
        subject = excluded.subject,
        body = excluded.body,
        priority = excluded.priority,
        kind = excluded.kind,
        metadata_json = excluded.metadata_json,
        status = excluded.status,
        updated_at_iso = excluded.updated_at_iso,
        updated_at_ms = excluded.updated_at_ms,
        file_mtime = excluded.file_mtime,
        file_sha256 = excluded.file_sha256,
        projected_at = excluded.projected_at`,
      [
        parsed.frontmatter.id,
        this.ownerAgentId,
        parsed.relPath,
        parsed.frontmatter.to ?? null,
        parsed.frontmatter.from ?? null,
        parsed.frontmatter.subject ?? null,
        parsed.body,
        parsed.frontmatter.priority ?? null,
        parsed.frontmatter.kind ?? "message",
        metadataJson,
        parsed.frontmatter.from_auth ?? "unknown",
        parsed.frontmatter.draft_status ?? "draft",
        dateIso,
        new Date(now).toISOString(),
        dateMs,
        now,
        parsed.mtime,
        parsed.sha256,
        now,
      ]
    );
  }

  /**
   * Remove a projected row when its source file is gone. The projector
   * passes the rel_path + a hint as to which table it was in.
   */
  removeByRelPath(
    table: "inbox" | "outbox" | "drafts",
    relPath: string
  ): void {
    this.assertOpen();
    if (table === "inbox") {
      this.db.run(`DELETE FROM inbox_messages WHERE rel_path = ?`, [relPath]);
    } else if (table === "outbox") {
      this.db.run(`DELETE FROM outbox_messages WHERE rel_path = ?`, [relPath]);
    } else {
      this.db.run(`DELETE FROM inbox_drafts WHERE rel_path = ?`, [relPath]);
    }
  }

  /**
   * Snapshot of DB-side projection state for diffing. Projector
   * compares against filesystem discovery. Returned in flat shape for
   * efficient diff loops.
   */
  snapshotProjection(): {
    inbox: Map<string, { relPath: string; sha: string }>;
    outbox: Map<string, { relPath: string; sha: string }>;
    drafts: Map<string, { relPath: string; sha: string }>;
  } {
    this.assertOpen();
    const inbox = new Map<string, { relPath: string; sha: string }>();
    for (const r of this.db
      .query<{ message_id: string; rel_path: string; file_sha256: string }, [string]>(
        `SELECT message_id, rel_path, file_sha256 FROM inbox_messages WHERE owner_agent_id = ?`
      )
      .all(this.ownerAgentId)) {
      inbox.set(r.message_id, { relPath: r.rel_path, sha: r.file_sha256 });
    }
    const outbox = new Map<string, { relPath: string; sha: string }>();
    for (const r of this.db
      .query<{ id: string; rel_path: string; file_sha256: string }, [string]>(
        `SELECT id, rel_path, file_sha256 FROM outbox_messages WHERE owner_agent_id = ?`
      )
      .all(this.ownerAgentId)) {
      outbox.set(r.id, { relPath: r.rel_path, sha: r.file_sha256 });
    }
    const drafts = new Map<string, { relPath: string; sha: string }>();
    for (const r of this.db
      .query<{ id: string; rel_path: string; file_sha256: string }, [string]>(
        `SELECT id, rel_path, file_sha256 FROM inbox_drafts WHERE owner_agent_id = ?`
      )
      .all(this.ownerAgentId)) {
      drafts.set(r.id, { relPath: r.rel_path, sha: r.file_sha256 });
    }
    return { inbox, outbox, drafts };
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  private getInboxRowByMessageId(messageId: string): RawInboxRow | null {
    const row = this.db
      .query<RawInboxRow, [string, string]>(
        `SELECT * FROM inbox_messages WHERE message_id = ? AND owner_agent_id = ?`
      )
      .get(messageId, this.ownerAgentId);
    return row ?? null;
  }

  private getAttachmentsForMessage(messageId: string): InboxAttachment[] {
    const rows = this.db
      .query<RawAttachmentRow, [string]>(
        `SELECT * FROM inbox_attachments WHERE message_id = ? ORDER BY id ASC`
      )
      .all(messageId);
    return rows.map(rowToAttachment);
  }

  private getAttachmentsForMessages(
    ids: string[]
  ): Map<string, InboxAttachment[]> {
    const out = new Map<string, InboxAttachment[]>();
    if (ids.length === 0) return out;
    const ph = ids.map(() => "?").join(",");
    const rows = this.db
      .query<RawAttachmentRow, string[]>(
        `SELECT * FROM inbox_attachments WHERE message_id IN (${ph}) ORDER BY id ASC`
      )
      .all(...ids);
    for (const r of rows) {
      const arr = out.get(r.message_id) ?? [];
      arr.push(rowToAttachment(r));
      out.set(r.message_id, arr);
    }
    return out;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("InboxEngine is closed");
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/**
 * Shape returned by `listOperatorInbox()` / `getOperatorMessage()`.
 * Lighter than `InboxMessage` — the operator view doesn't have a DB
 * projection, so there's no `id: number`, no `projected_at`, no
 * `file_sha256` from a column. Attachment ids are synthesized from
 * filename index since there's no persisted id either.
 */
export interface OperatorInboxMessage {
  id: string;                       // message id from frontmatter / filename
  relPath: string;                  // relative to operator_mail_root
  fromAuth: string;
  fromDisplay: string;
  toAgent: string | null;
  subject: string | null;
  priority: import("./types").MessagePriority | null;
  kind: import("./types").MessageKind;
  threadId: string | null;
  inReplyTo: string | null;
  metadata: Record<string, unknown> | null;
  body: string;
  status: InboxStatus;
  dateIso: string;
  dateMs: number;
  originalRecipient: string | null; // from metadata.original_recipient on unrouted
  attachments: Array<{
    filename: string;
    relPath: string;
    contentType: string | null;
    sizeBytes: number;
    sha256: string;
  }>;
}

function parsedToOperatorMessage(
  parsed: import("./types").ParsedMailFile
): OperatorInboxMessage {
  const status: InboxStatus =
    parsed.source === "inbox"
      ? "unread"
      : parsed.source === "inbox/read"
        ? "read"
        : "tombstoned";
  const meta = parsed.frontmatter.metadata ?? null;
  const originalRecipient =
    meta && typeof meta === "object" && typeof (meta as Record<string, unknown>).original_recipient === "string"
      ? ((meta as Record<string, unknown>).original_recipient as string)
      : null;
  const iso = parsed.frontmatter.date;
  let ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    const dateOnly = Date.parse(`${iso}T00:00:00Z`);
    ms = Number.isNaN(dateOnly) ? 0 : dateOnly;
  }
  return {
    id: parsed.frontmatter.id,
    relPath: parsed.relPath,
    fromAuth: parsed.frontmatter.from_auth ?? "unknown",
    fromDisplay: parsed.frontmatter.from,
    toAgent: parsed.frontmatter.to ?? null,
    subject: parsed.frontmatter.subject ?? null,
    priority: parsed.frontmatter.priority ?? null,
    kind: parsed.frontmatter.kind ?? "message",
    threadId: parsed.frontmatter.thread_id ?? null,
    inReplyTo: parsed.frontmatter.in_reply_to ?? null,
    metadata: meta,
    body: parsed.body,
    status,
    dateIso: iso,
    dateMs: ms,
    originalRecipient,
    attachments: parsed.attachments.map((a) => ({
      filename: a.filename,
      relPath: a.relPath,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
      sha256: a.sha256,
    })),
  };
}

function guessContentTypeFromExt(filename: string): string | null {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = filename.slice(dot).toLowerCase();
  switch (ext) {
    case ".md": return "text/markdown";
    case ".txt": return "text/plain";
    case ".json": return "application/json";
    case ".pdf": return "application/pdf";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".svg": return "image/svg+xml";
    case ".html":
    case ".htm": return "text/html";
    case ".csv": return "text/csv";
    default: return null;
  }
}

/**
 * Parse a `from_auth` value into its agent id if it's an `agent:<id>`
 * scheme. Returns null for operator / unknown / malformed values.
 */
function parseAgentAuth(fromAuth: string | undefined): string | null {
  if (!fromAuth) return null;
  const m = /^agent:([A-Za-z0-9_-]+)$/.exec(fromAuth);
  return m ? m[1] : null;
}

function parseDateMs(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    // Tolerate date-only values (legacy files used plain YYYY-MM-DD).
    const dateOnly = Date.parse(`${iso}T00:00:00Z`);
    if (!Number.isNaN(dateOnly)) return dateOnly;
    return 0;
  }
  return ms;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function escapeFts(query: string): string {
  const tokens = query.split(/[^A-Za-z0-9]+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

function clampPagination(opts: { limit?: number; offset?: number }): {
  limit: number;
  offset: number;
} {
  const DEFAULT = 50;
  const MAX = 500;
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? DEFAULT)), MAX);
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  return { limit, offset };
}

function atomicWrite(absPath: string, contents: string): void {
  const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, contents, "utf8");
  renameSync(tmp, absPath);
}

/**
 * Move an inbox file (single-file or message.md within a dir) between
 * inbox/, inbox/read/, inbox/tombstoned/. Returns the new rel_path.
 */
function moveInboxFile(
  mailRoot: string,
  currentRelPath: string,
  target: "inbox" | "read" | "tombstoned"
): string {
  // currentRelPath is something like:
  //   "inbox/{id}.md"                 → simple
  //   "inbox/read/{id}.md"
  //   "inbox/{id}/message.md"         → multi-file dir
  //   "inbox/read/{id}/message.md"
  const parts = currentRelPath.split("/");
  if (parts[0] !== "inbox") {
    throw new Error(`moveInboxFile: not an inbox path: ${currentRelPath}`);
  }

  // Detect state subdir (read/tombstoned) vs nothing.
  let idx = 1;
  if (parts[idx] === "read" || parts[idx] === "tombstoned") {
    idx += 1;
  }
  // Now parts[idx..] is "{id}.md" or "{id}/message.md"
  const remainder = parts.slice(idx).join("/");
  const isMultiFile = remainder.endsWith("/message.md");
  const itemName = isMultiFile ? remainder.slice(0, -"/message.md".length) : remainder;

  const currentAbs = join(mailRoot, currentRelPath);
  const currentItemAbs = isMultiFile ? dirname(currentAbs) : currentAbs;

  const newPrefix =
    target === "inbox" ? "inbox" : target === "read" ? "inbox/read" : "inbox/tombstoned";
  const newItemRel = `${newPrefix}/${itemName}`;
  const newItemAbs = join(mailRoot, newItemRel);

  mkdirSync(dirname(newItemAbs), { recursive: true });
  renameSync(currentItemAbs, newItemAbs);

  const newRel = isMultiFile ? `${newItemRel}/message.md` : newItemRel;
  return newRel;
}

/**
 * Avoid attachment-filename collisions within one message dir. Caller
 * passes the target dir + filename; we rename with -2, -3, ... as needed.
 */
function safeAttachmentName(filename: string, dir: string): string {
  const baseName = basename(filename);
  let candidate = baseName;
  let n = 2;
  while (existsSync(join(dir, candidate))) {
    const dot = baseName.lastIndexOf(".");
    const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
    const ext = dot > 0 ? baseName.slice(dot) : "";
    candidate = `${stem}-${n}${ext}`;
    n += 1;
    if (n > 1000) throw new Error(`attachment-naming loop exhausted for ${filename}`);
  }
  return candidate;
}

function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    const home = process.env.HOME;
    if (!home) throw new Error(`HOME not set; cannot expand ${p}`);
    return resolve(home, p.slice(2));
  }
  return resolve(p);
}
