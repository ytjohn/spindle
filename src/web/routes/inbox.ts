/**
 * Phase 4.4a HTTP surface for the inbox subsystem.
 *
 * All routes under `/spindle/{inbox,outbox,drafts,routes}/*`. Bearer
 * auth is provided by the authed plugin scope at registration time
 * (server.ts mounts these inside the same `app.register(async (authed) => ...)`
 * block that 4.1's memory routes use).
 *
 * Envelope + pagination helpers are shared with memory routes via
 * `src/web/query.ts`. We deliberately keep a minimal serializer layer
 * rather than dropping engine types straight onto the wire so we have
 * a stable API shape the UI can rely on.
 */

import type { FastifyInstance } from "fastify";
import { readFileSync, existsSync } from "fs";
import type { InboxEngine } from "../../inbox/engine";
import type {
  AgentRoute,
  Draft,
  DraftPatch,
  InboxMessage,
  InboxStatus,
  MessageKind,
  MessagePriority,
  OutboxMessage,
} from "../../inbox/types";
import { envelope, parseBool, parseCommaList, parsePagination, toNumber } from "../query";

export interface InboxRoutesDeps {
  agentId: string;
  engine: InboxEngine;
}

const VALID_STATUSES: ReadonlySet<InboxStatus | "all"> = new Set([
  "unread",
  "read",
  "tombstoned",
  "all",
]);

const VALID_KINDS: ReadonlySet<MessageKind> = new Set([
  "message",
  "task",
  "notice",
  "reply",
]);

const VALID_PRIORITIES: ReadonlySet<MessagePriority> = new Set([
  "low",
  "normal",
  "high",
  "urgent",
]);

function asKinds(v: unknown): MessageKind[] | undefined {
  const list = parseCommaList(v);
  if (!list) return undefined;
  const filtered = list.filter((k): k is MessageKind =>
    VALID_KINDS.has(k as MessageKind)
  );
  return filtered.length > 0 ? filtered : undefined;
}

function asPriorities(v: unknown): MessagePriority[] | undefined {
  const list = parseCommaList(v);
  if (!list) return undefined;
  const filtered = list.filter((p): p is MessagePriority =>
    VALID_PRIORITIES.has(p as MessagePriority)
  );
  return filtered.length > 0 ? filtered : undefined;
}

function serializeInboxMessage(m: InboxMessage) {
  return {
    id: m.id,
    owner_agent_id: m.ownerAgentId,
    rel_path: m.relPath,
    from_auth: m.fromAuth,
    from: m.fromDisplay,
    to: m.toAgent,
    subject: m.subject,
    priority: m.priority,
    kind: m.kind,
    thread_id: m.threadId,
    in_reply_to: m.inReplyTo,
    metadata: m.metadata,
    body: m.body,
    status: m.status,
    date: m.dateIso,
    date_ms: m.dateMs,
    file_mtime: m.fileMtime,
    file_sha256: m.fileSha256,
    projected_at: m.projectedAt,
    attachments: m.attachments.map((a) => ({
      id: a.id,
      filename: a.filename,
      rel_path: a.relPath,
      content_type: a.contentType,
      size_bytes: a.sizeBytes,
      sha256: a.sha256,
    })),
  };
}

function serializeOutboxMessage(m: OutboxMessage) {
  return {
    id: m.id,
    owner_agent_id: m.ownerAgentId,
    rel_path: m.relPath,
    to: m.toAgent,
    to_mail_root: m.toMailRoot,
    from: m.fromDisplay,
    subject: m.subject,
    body: m.body,
    kind: m.kind,
    thread_id: m.threadId,
    sent_at: m.sentAtIso,
    sent_at_ms: m.sentAtMs,
    delivery_status: m.deliveryStatus,
    delivery_error: m.deliveryError,
    file_mtime: m.fileMtime,
    file_sha256: m.fileSha256,
    projected_at: m.projectedAt,
  };
}

function serializeDraft(d: Draft) {
  return {
    id: d.id,
    owner_agent_id: d.ownerAgentId,
    rel_path: d.relPath,
    to: d.toAgent,
    from: d.fromDisplay,
    subject: d.subject,
    body: d.body,
    priority: d.priority,
    kind: d.kind,
    metadata: d.metadata,
    author_auth: d.authorAuth,
    status: d.status,
    created_at: d.createdAtIso,
    updated_at: d.updatedAtIso,
    created_at_ms: d.createdAtMs,
    updated_at_ms: d.updatedAtMs,
    file_mtime: d.fileMtime,
    file_sha256: d.fileSha256,
    projected_at: d.projectedAt,
  };
}

function serializeRoute(r: AgentRoute) {
  return {
    agent_id: r.agentId,
    mail_root: r.mailRoot,
    display_name: r.displayName,
    avatar_path: r.avatarPath,
    capabilities: r.capabilities,
    last_seen_at: r.lastSeenAt,
    created_by: r.createdBy,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

// ============================================================================
// Inbox routes — /spindle/inbox/*
// ============================================================================

export async function registerInboxRoutes(
  app: FastifyInstance,
  deps: InboxRoutesDeps
): Promise<void> {
  // GET /spindle/inbox
  app.get<{ Querystring: Record<string, unknown> }>(
    "/spindle/inbox",
    async (request) => {
      const q = request.query;
      const { limit, offset } = parsePagination(q);
      const statusRaw = typeof q.status === "string" ? q.status : "unread";
      const status: InboxStatus | "all" = VALID_STATUSES.has(
        statusRaw as InboxStatus | "all"
      )
        ? (statusRaw as InboxStatus | "all")
        : "unread";
      const result = deps.engine.listInbox({
        status,
        kind: asKinds(q.kind),
        priority: asPriorities(q.priority),
        threadId: typeof q.thread_id === "string" ? q.thread_id : undefined,
        from: typeof q.from === "string" ? q.from : undefined,
        limit,
        offset,
      });
      return envelope(
        { items: result.items, total: result.total, limit, offset, hasMore: offset + result.items.length < result.total },
        serializeInboxMessage
      );
    }
  );

  // GET /spindle/inbox/search
  app.get<{ Querystring: Record<string, unknown> }>(
    "/spindle/inbox/search",
    async (request, reply) => {
      const q = request.query;
      if (typeof q.q !== "string" || q.q.length === 0) {
        return reply.code(400).send({ error: "q_required" });
      }
      const { limit, offset } = parsePagination(q);
      const statusRaw = typeof q.status === "string" ? q.status : "all";
      const status: InboxStatus | "all" = VALID_STATUSES.has(
        statusRaw as InboxStatus | "all"
      )
        ? (statusRaw as InboxStatus | "all")
        : "all";
      const result = deps.engine.searchInbox({
        q: q.q,
        status,
        limit,
        offset,
      });
      return envelope(
        { items: result.items, total: result.total, limit, offset, hasMore: offset + result.items.length < result.total },
        serializeInboxMessage
      );
    }
  );

  // GET /spindle/inbox/status
  app.get("/spindle/inbox/status", async () => {
    const s = deps.engine.getInboxStatus();
    return {
      unread_count: s.unreadCount,
      unread_senders: s.unreadSenders,
      has_priority: s.hasPriority,
    };
  });

  // GET /spindle/inbox/:id
  app.get<{ Params: { id: string } }>(
    "/spindle/inbox/:id",
    async (request, reply) => {
      const msg = deps.engine.getMessage(request.params.id);
      if (!msg) return reply.code(404).send({ error: "message_not_found" });
      return serializeInboxMessage(msg);
    }
  );

  // POST /spindle/inbox/:id/read
  app.post<{ Params: { id: string } }>(
    "/spindle/inbox/:id/read",
    async (request, reply) => {
      const msg = deps.engine.markRead(request.params.id);
      if (!msg) return reply.code(404).send({ error: "message_not_found_or_already_read" });
      return serializeInboxMessage(msg);
    }
  );

  // POST /spindle/inbox/:id/unread
  app.post<{ Params: { id: string } }>(
    "/spindle/inbox/:id/unread",
    async (request, reply) => {
      const msg = deps.engine.markUnread(request.params.id);
      if (!msg) return reply.code(404).send({ error: "message_not_found_or_already_unread" });
      return serializeInboxMessage(msg);
    }
  );

  // DELETE /spindle/inbox/:id — tombstone
  app.delete<{ Params: { id: string }; Querystring: { reason?: string } }>(
    "/spindle/inbox/:id",
    async (request, reply) => {
      const reason =
        typeof request.query.reason === "string" &&
        request.query.reason.length > 0
          ? request.query.reason
          : "operator:web-ui";
      const msg = deps.engine.tombstone(request.params.id, reason);
      if (!msg)
        return reply
          .code(404)
          .send({ error: "message_not_found_or_already_tombstoned" });
      return serializeInboxMessage(msg);
    }
  );

  // POST /spindle/inbox/:id/restore
  app.post<{ Params: { id: string } }>(
    "/spindle/inbox/:id/restore",
    async (request, reply) => {
      const msg = deps.engine.restoreTombstoned(request.params.id);
      if (!msg)
        return reply
          .code(404)
          .send({ error: "message_not_found_or_not_tombstoned" });
      return serializeInboxMessage(msg);
    }
  );

  // GET /spindle/inbox/attachments/:attId — stream file bytes
  app.get<{ Params: { attId: string } }>(
    "/spindle/inbox/attachments/:attId",
    async (request, reply) => {
      const attId = toNumber(request.params.attId);
      if (attId === undefined) {
        return reply.code(400).send({ error: "invalid_attachment_id" });
      }
      const fetched = deps.engine.getAttachment(attId);
      if (!fetched || !existsSync(fetched.absPath)) {
        return reply.code(404).send({ error: "attachment_not_found" });
      }
      const bytes = readFileSync(fetched.absPath);
      reply
        .header(
          "Content-Type",
          fetched.attachment.contentType ?? "application/octet-stream"
        )
        .header(
          "Content-Disposition",
          `inline; filename="${encodeURIComponent(fetched.attachment.filename)}"`
        );
      return reply.send(bytes);
    }
  );

  // ---------------------------------------------------------------------------
  // Operator inbox — read + state transitions over the shared
  // operator_mail_root. No DB projection (see InboxEngine for why),
  // so these routes walk the filesystem on each call. Full attachment
  // download mirror of the main inbox exists via
  // GET /spindle/operator-inbox/:id/attachments/:filename.
  // ---------------------------------------------------------------------------
  app.get<{
    Querystring: { status?: string; limit?: string; offset?: string };
  }>("/spindle/operator-inbox", async (request) => {
    const { limit, offset } = parsePagination(request.query);
    const statusParam =
      typeof request.query.status === "string" ? request.query.status : "all";
    const all = deps.engine.listOperatorInbox();
    const filtered =
      statusParam === "all"
        ? all
        : all.filter((m) => m.status === statusParam);
    const page = filtered.slice(offset, offset + limit);
    return {
      items: page.map(serializeOperatorMessage),
      total: filtered.length,
      limit,
      offset,
      has_more: offset + page.length < filtered.length,
    };
  });

  app.get("/spindle/operator-inbox/status", async () => {
    const s = deps.engine.getOperatorInboxStatus();
    return {
      unread_count: s.unreadCount,
      unread_senders: s.unreadSenders,
      has_priority: s.hasPriority,
    };
  });

  app.get<{ Params: { id: string } }>(
    "/spindle/operator-inbox/:id",
    async (request, reply) => {
      const msg = deps.engine.getOperatorMessage(request.params.id);
      if (!msg)
        return reply.code(404).send({ error: "operator_message_not_found" });
      return serializeOperatorMessage(msg);
    }
  );

  app.post<{ Params: { id: string } }>(
    "/spindle/operator-inbox/:id/read",
    async (request, reply) => {
      const msg = deps.engine.markOperatorRead(request.params.id);
      if (!msg)
        return reply
          .code(404)
          .send({ error: "message_not_found_or_already_read" });
      return serializeOperatorMessage(msg);
    }
  );

  app.post<{ Params: { id: string } }>(
    "/spindle/operator-inbox/:id/unread",
    async (request, reply) => {
      const msg = deps.engine.markOperatorUnread(request.params.id);
      if (!msg)
        return reply
          .code(404)
          .send({ error: "message_not_found_or_already_unread" });
      return serializeOperatorMessage(msg);
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/spindle/operator-inbox/:id",
    async (request, reply) => {
      const msg = deps.engine.tombstoneOperator(request.params.id);
      if (!msg)
        return reply
          .code(404)
          .send({ error: "message_not_found_or_already_tombstoned" });
      return serializeOperatorMessage(msg);
    }
  );

  app.post<{ Params: { id: string } }>(
    "/spindle/operator-inbox/:id/restore",
    async (request, reply) => {
      const msg = deps.engine.restoreOperator(request.params.id);
      if (!msg)
        return reply
          .code(404)
          .send({ error: "message_not_found_or_not_tombstoned" });
      return serializeOperatorMessage(msg);
    }
  );

  app.get<{ Params: { id: string; filename: string } }>(
    "/spindle/operator-inbox/:id/attachments/:filename",
    async (request, reply) => {
      const fetched = deps.engine.getOperatorAttachment(
        request.params.id,
        request.params.filename
      );
      if (!fetched) return reply.code(404).send({ error: "attachment_not_found" });
      const { readFileSync } = await import("fs");
      const bytes = readFileSync(fetched.absPath);
      reply
        .header(
          "Content-Type",
          fetched.contentType ?? "application/octet-stream"
        )
        .header(
          "Content-Disposition",
          `inline; filename="${encodeURIComponent(request.params.filename)}"`
        );
      return reply.send(bytes);
    }
  );
}

function serializeOperatorMessage(
  m: import("../../inbox/engine").OperatorInboxMessage
) {
  return {
    id: m.id,
    rel_path: m.relPath,
    from_auth: m.fromAuth,
    from: m.fromDisplay,
    to: m.toAgent,
    subject: m.subject,
    priority: m.priority,
    kind: m.kind,
    thread_id: m.threadId,
    in_reply_to: m.inReplyTo,
    metadata: m.metadata,
    body: m.body,
    status: m.status,
    date: m.dateIso,
    date_ms: m.dateMs,
    original_recipient: m.originalRecipient,
    attachments: m.attachments.map((a) => ({
      filename: a.filename,
      rel_path: a.relPath,
      content_type: a.contentType,
      size_bytes: a.sizeBytes,
      sha256: a.sha256,
    })),
  };
}

// ============================================================================
// Outbox routes — /spindle/outbox/*
// ============================================================================

export async function registerOutboxRoutes(
  app: FastifyInstance,
  deps: InboxRoutesDeps
): Promise<void> {
  app.get<{ Querystring: Record<string, unknown> }>(
    "/spindle/outbox",
    async (request) => {
      const q = request.query;
      const { limit, offset } = parsePagination(q);
      const statusList = parseCommaList(q.delivery_status);
      const deliveryStatus = statusList?.filter((s) =>
        ["delivered", "unrouted", "failed"].includes(s)
      ) as ("delivered" | "unrouted" | "failed")[] | undefined;
      const result = deps.engine.listOutbox({
        deliveryStatus,
        limit,
        offset,
      });
      return envelope(
        { items: result.items, total: result.total, limit, offset, hasMore: offset + result.items.length < result.total },
        serializeOutboxMessage
      );
    }
  );

  app.get<{ Params: { id: string } }>(
    "/spindle/outbox/:id",
    async (request, reply) => {
      const msg = deps.engine.getOutboxMessage(request.params.id);
      if (!msg) return reply.code(404).send({ error: "outbox_message_not_found" });
      return serializeOutboxMessage(msg);
    }
  );

  // POST /spindle/outbox/send — one-shot send (skip draft stage)
  app.post<{
    Body: {
      to?: unknown;
      from?: unknown;
      subject?: unknown;
      body?: unknown;
      priority?: unknown;
      kind?: unknown;
      metadata?: unknown;
      thread_id?: unknown;
      in_reply_to?: unknown;
    };
  }>("/spindle/outbox/send", async (request, reply) => {
    const body = request.body ?? {};
    if (typeof body.to !== "string" || body.to.length === 0) {
      return reply.code(400).send({ error: "to_required" });
    }
    if (typeof body.body !== "string" || body.body.length === 0) {
      return reply.code(400).send({ error: "body_required" });
    }
    const priorityStr = typeof body.priority === "string" ? body.priority : undefined;
    if (priorityStr && !VALID_PRIORITIES.has(priorityStr as MessagePriority)) {
      return reply.code(400).send({ error: "invalid_priority" });
    }
    const kindStr = typeof body.kind === "string" ? body.kind : undefined;
    if (kindStr && !VALID_KINDS.has(kindStr as MessageKind)) {
      return reply.code(400).send({ error: "invalid_kind" });
    }
    const metadataRaw = body.metadata;
    if (
      metadataRaw !== undefined &&
      (metadataRaw === null || typeof metadataRaw !== "object" || Array.isArray(metadataRaw))
    ) {
      return reply.code(400).send({ error: "invalid_metadata" });
    }

    const from =
      typeof body.from === "string" && body.from.length > 0
        ? body.from
        : deps.agentId;
    const result = deps.engine.send({
      to: body.to,
      from,
      fromAuth: `operator:web-ui`,
      subject: typeof body.subject === "string" ? body.subject : undefined,
      body: body.body,
      priority: priorityStr as MessagePriority | undefined,
      kind: kindStr as MessageKind | undefined,
      metadata: metadataRaw as Record<string, unknown> | undefined,
      threadId: typeof body.thread_id === "string" ? body.thread_id : undefined,
      inReplyTo: typeof body.in_reply_to === "string" ? body.in_reply_to : undefined,
    });
    return reply.code(201).send({
      message_id: result.messageId,
      rel_path: result.relPath,
      delivery_status: result.deliveryStatus,
      delivery_error: result.deliveryError,
      delivered_to: result.deliveredTo,
      delivered_mail_root: result.deliveredMailRoot,
      outbox_retained: result.outboxRetained,
      outbox_rel_path: result.outboxRelPath,
      available_routes: result.availableRoutes
        ? result.availableRoutes.map((r) => ({
            agent_id: r.agentId,
            display_name: r.displayName,
            capabilities: r.capabilities,
          }))
        : undefined,
    });
  });
}

// ============================================================================
// Draft routes — /spindle/drafts/*
// ============================================================================

export async function registerDraftRoutes(
  app: FastifyInstance,
  deps: InboxRoutesDeps
): Promise<void> {
  app.get<{ Querystring: Record<string, unknown> }>(
    "/spindle/drafts",
    async (request) => {
      const q = request.query;
      const { limit, offset } = parsePagination(q);
      const statusRaw = typeof q.status === "string" ? q.status : undefined;
      const status =
        statusRaw === "draft" || statusRaw === "ready" ? statusRaw : undefined;
      const result = deps.engine.listDrafts({ limit, offset, status });
      return envelope(
        { items: result.items, total: result.total, limit, offset, hasMore: offset + result.items.length < result.total },
        serializeDraft
      );
    }
  );

  app.get<{ Params: { id: string } }>(
    "/spindle/drafts/:id",
    async (request, reply) => {
      const d = deps.engine.getDraft(request.params.id);
      if (!d) return reply.code(404).send({ error: "draft_not_found" });
      return serializeDraft(d);
    }
  );

  app.post<{
    Body: {
      to?: unknown;
      from?: unknown;
      subject?: unknown;
      body?: unknown;
      priority?: unknown;
      kind?: unknown;
      metadata?: unknown;
    };
  }>("/spindle/drafts", async (request, reply) => {
    const body = request.body ?? {};
    if (typeof body.body !== "string" || body.body.length === 0) {
      return reply.code(400).send({ error: "body_required" });
    }
    const priorityStr = typeof body.priority === "string" ? body.priority : undefined;
    if (priorityStr && !VALID_PRIORITIES.has(priorityStr as MessagePriority)) {
      return reply.code(400).send({ error: "invalid_priority" });
    }
    const kindStr = typeof body.kind === "string" ? body.kind : undefined;
    if (kindStr && !VALID_KINDS.has(kindStr as MessageKind)) {
      return reply.code(400).send({ error: "invalid_kind" });
    }
    const draft = deps.engine.saveDraft({
      to: typeof body.to === "string" ? body.to : null,
      from: typeof body.from === "string" ? body.from : null,
      fromAuth: `operator:web-ui`,
      subject: typeof body.subject === "string" ? body.subject : null,
      body: body.body,
      priority: priorityStr as MessagePriority | undefined,
      kind: kindStr as MessageKind | undefined,
      metadata: body.metadata as Record<string, unknown> | null,
    });
    return reply.code(201).send(serializeDraft(draft));
  });

  app.patch<{
    Params: { id: string };
    Body: Record<string, unknown>;
  }>("/spindle/drafts/:id", async (request, reply) => {
    const body = request.body ?? {};
    const patch: DraftPatch = {};
    if ("to" in body) patch.to = (body.to as string | null) ?? null;
    if ("from" in body) patch.from = (body.from as string | null) ?? null;
    if ("subject" in body) patch.subject = (body.subject as string | null) ?? null;
    if ("body" in body && typeof body.body === "string") patch.body = body.body;
    if ("priority" in body) {
      const priorityStr = typeof body.priority === "string" ? body.priority : null;
      if (priorityStr && !VALID_PRIORITIES.has(priorityStr as MessagePriority)) {
        return reply.code(400).send({ error: "invalid_priority" });
      }
      patch.priority = priorityStr as MessagePriority | null;
    }
    if ("kind" in body) {
      const kindStr = typeof body.kind === "string" ? body.kind : undefined;
      if (kindStr && !VALID_KINDS.has(kindStr as MessageKind)) {
        return reply.code(400).send({ error: "invalid_kind" });
      }
      patch.kind = kindStr as MessageKind | undefined;
    }
    if ("metadata" in body) {
      patch.metadata = body.metadata as Record<string, unknown> | null;
    }
    if ("status" in body) {
      const s = typeof body.status === "string" ? body.status : undefined;
      if (s !== "draft" && s !== "ready") {
        return reply.code(400).send({ error: "invalid_status" });
      }
      patch.status = s;
    }
    const updated = deps.engine.updateDraft(request.params.id, patch);
    if (!updated) return reply.code(404).send({ error: "draft_not_found" });
    return serializeDraft(updated);
  });

  app.delete<{ Params: { id: string } }>(
    "/spindle/drafts/:id",
    async (request, reply) => {
      const ok = deps.engine.cancelDraft(request.params.id);
      if (!ok) return reply.code(404).send({ error: "draft_not_found" });
      return reply.code(204).send();
    }
  );

  // GET /spindle/drafts/:id/attachments — list current attachments on a draft
  app.get<{ Params: { id: string } }>(
    "/spindle/drafts/:id/attachments",
    async (request, reply) => {
      const draft = deps.engine.getDraft(request.params.id);
      if (!draft) return reply.code(404).send({ error: "draft_not_found" });
      const atts = deps.engine.listDraftAttachments(request.params.id);
      return {
        items: atts.map((a) => ({
          filename: a.filename,
          size_bytes: a.sizeBytes,
          content_type: a.contentType,
          rel_path: a.relPath,
        })),
        total: atts.length,
      };
    }
  );

  // POST /spindle/drafts/:id/attachments — upload raw bytes with X-Filename.
  // Accepts any body; Fastify's content-type parser is registered at server
  // boot for binary uploads.
  app.post<{ Params: { id: string } }>(
    "/spindle/drafts/:id/attachments",
    async (request, reply) => {
      const filename =
        typeof request.headers["x-filename"] === "string"
          ? (request.headers["x-filename"] as string)
          : null;
      if (!filename || filename.length === 0) {
        return reply.code(400).send({ error: "x_filename_header_required" });
      }
      if (filename.includes("/") || filename.includes("..")) {
        return reply.code(400).send({ error: "invalid_filename" });
      }
      const draft = deps.engine.getDraft(request.params.id);
      if (!draft) return reply.code(404).send({ error: "draft_not_found" });
      const bytes = request.body;
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        return reply.code(400).send({ error: "body_required" });
      }
      const contentType =
        typeof request.headers["content-type"] === "string"
          ? (request.headers["content-type"] as string)
          : undefined;
      const att = deps.engine.addDraftAttachment(
        request.params.id,
        filename,
        bytes,
        contentType
      );
      return reply.code(201).send({
        filename: att.filename,
        size_bytes: att.sizeBytes,
        sha256: att.sha256,
        rel_path: att.relPath,
      });
    }
  );

  app.delete<{ Params: { id: string; filename: string } }>(
    "/spindle/drafts/:id/attachments/:filename",
    async (request, reply) => {
      const draft = deps.engine.getDraft(request.params.id);
      if (!draft) return reply.code(404).send({ error: "draft_not_found" });
      try {
        const ok = deps.engine.removeDraftAttachment(
          request.params.id,
          request.params.filename
        );
        if (!ok) return reply.code(404).send({ error: "attachment_not_found" });
      } catch (err) {
        return reply.code(400).send({
          error: "invalid_filename",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return reply.code(204).send();
    }
  );

  // POST /spindle/drafts/:id/send — commit + delete draft
  app.post<{ Params: { id: string } }>(
    "/spindle/drafts/:id/send",
    async (request, reply) => {
      let result;
      try {
        result = deps.engine.sendDraft(
          request.params.id,
          `operator:web-ui`
        );
      } catch (err) {
        return reply.code(400).send({
          error: "send_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      if (!result) return reply.code(404).send({ error: "draft_not_found" });
      return reply.code(201).send({
        message_id: result.messageId,
        rel_path: result.relPath,
        delivery_status: result.deliveryStatus,
        delivered_to: result.deliveredTo,
        delivered_mail_root: result.deliveredMailRoot,
        outbox_retained: result.outboxRetained,
        outbox_rel_path: result.outboxRelPath,
      });
    }
  );
}

// ============================================================================
// Routes CRUD — /spindle/routes/*
// ============================================================================

export async function registerAgentRoutesRoutes(
  app: FastifyInstance,
  deps: InboxRoutesDeps
): Promise<void> {
  app.get("/spindle/routes", async () => {
    const routes = deps.engine.listRoutes();
    return { items: routes.map(serializeRoute), total: routes.length };
  });

  app.get<{ Params: { agentId: string } }>(
    "/spindle/routes/:agentId",
    async (request, reply) => {
      const r = deps.engine.getRoute(request.params.agentId);
      if (!r) return reply.code(404).send({ error: "route_not_found" });
      return serializeRoute(r);
    }
  );

  app.post<{
    Body: {
      agent_id?: unknown;
      mail_root?: unknown;
      display_name?: unknown;
      avatar_path?: unknown;
      capabilities?: unknown;
    };
  }>("/spindle/routes", async (request, reply) => {
    const body = request.body ?? {};
    if (typeof body.agent_id !== "string" || body.agent_id.length === 0) {
      return reply.code(400).send({ error: "agent_id_required" });
    }
    if (typeof body.mail_root !== "string" || body.mail_root.length === 0) {
      return reply.code(400).send({ error: "mail_root_required" });
    }
    if (typeof body.display_name !== "string" || body.display_name.length === 0) {
      return reply.code(400).send({ error: "display_name_required" });
    }
    const caps = Array.isArray(body.capabilities)
      ? (body.capabilities as unknown[]).filter((c): c is string => typeof c === "string")
      : undefined;
    const route = deps.engine.upsertRoute({
      agentId: body.agent_id,
      mailRoot: body.mail_root,
      displayName: body.display_name,
      avatarPath: typeof body.avatar_path === "string" ? body.avatar_path : null,
      capabilities: caps,
      createdBy: "operator",
    });
    return reply.code(201).send(serializeRoute(route));
  });

  app.patch<{
    Params: { agentId: string };
    Body: Record<string, unknown>;
  }>("/spindle/routes/:agentId", async (request, reply) => {
    const existing = deps.engine.getRoute(request.params.agentId);
    if (!existing) return reply.code(404).send({ error: "route_not_found" });
    const body = request.body ?? {};
    const mailRoot =
      typeof body.mail_root === "string" ? body.mail_root : existing.mailRoot;
    const displayName =
      typeof body.display_name === "string"
        ? body.display_name
        : existing.displayName;
    const avatarPath =
      "avatar_path" in body
        ? typeof body.avatar_path === "string"
          ? body.avatar_path
          : null
        : existing.avatarPath;
    const caps =
      "capabilities" in body && Array.isArray(body.capabilities)
        ? (body.capabilities as unknown[]).filter((c): c is string => typeof c === "string")
        : existing.capabilities ?? undefined;
    const updated = deps.engine.upsertRoute({
      agentId: request.params.agentId,
      mailRoot,
      displayName,
      avatarPath: avatarPath ?? null,
      capabilities: caps,
      createdBy: existing.createdBy,
    });
    return serializeRoute(updated);
  });

  app.delete<{ Params: { agentId: string } }>(
    "/spindle/routes/:agentId",
    async (request, reply) => {
      try {
        const ok = deps.engine.deleteRoute(request.params.agentId);
        if (!ok) return reply.code(404).send({ error: "route_not_found" });
      } catch (err) {
        return reply.code(400).send({
          error: "cannot_delete_reserved",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return reply.code(204).send();
    }
  );
}
