import type { FastifyInstance } from "fastify";
import type { MemoryEngine } from "../../memory/engine";
import type { MemoryKind, Visibility } from "../../memory/types";
import { toNumber } from "../query";
import { serializeMemory } from "./memories";

export interface MemoriesCrudDeps {
  agentId: string;
  engine: MemoryEngine;
}

const VALID_KINDS: ReadonlySet<MemoryKind> = new Set([
  "episodic",
  "semantic",
  "procedural",
]);

const VALID_VISIBILITIES: ReadonlySet<Visibility> = new Set([
  "private",
  "shared",
  "thread",
]);

interface CreateBody {
  content?: unknown;
  kind?: unknown;
  visibility?: unknown;
  thread_id?: unknown;
  metadata?: unknown;
}

interface PatchBody {
  content?: unknown;
  kind?: unknown;
  visibility?: unknown;
  thread_id?: unknown;
  metadata?: unknown;
}

function asKind(v: unknown): MemoryKind | undefined {
  return typeof v === "string" && VALID_KINDS.has(v as MemoryKind)
    ? (v as MemoryKind)
    : undefined;
}

function asVisibility(v: unknown): Visibility | undefined {
  return typeof v === "string" && VALID_VISIBILITIES.has(v as Visibility)
    ? (v as Visibility)
    : undefined;
}

function asMetadata(v: unknown): Record<string, unknown> | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return undefined;
}

export async function registerMemoriesCrudRoutes(
  app: FastifyInstance,
  deps: MemoriesCrudDeps
): Promise<void> {
  // POST /spindle/memories — operator-create. Visibility defaults to
  // private (matches the LLM store path default).
  app.post<{ Body: CreateBody }>(
    "/spindle/memories",
    async (request, reply) => {
      const body = request.body ?? {};
      if (typeof body.content !== "string" || body.content.length === 0) {
        return reply.code(400).send({ error: "content_required" });
      }

      const kind = asKind(body.kind);
      if (body.kind !== undefined && kind === undefined) {
        return reply.code(400).send({ error: "invalid_kind" });
      }
      const visibility = asVisibility(body.visibility);
      if (body.visibility !== undefined && visibility === undefined) {
        return reply.code(400).send({ error: "invalid_visibility" });
      }
      const metadata = asMetadata(body.metadata);
      if (body.metadata !== undefined && metadata === undefined) {
        return reply.code(400).send({ error: "invalid_metadata" });
      }
      const threadId =
        typeof body.thread_id === "string" ? body.thread_id : undefined;
      if (visibility === "thread" && !threadId) {
        return reply.code(400).send({ error: "thread_id_required" });
      }

      const id = await deps.engine.store(deps.agentId, {
        content: body.content,
        kind: kind ?? "semantic",
        visibility: visibility ?? "private",
        threadId,
        metadata: metadata ?? undefined,
      });
      const memory = deps.engine.getMemoryById(deps.agentId, id);
      if (!memory) {
        return reply.code(500).send({ error: "store_failed" });
      }
      return reply.code(201).send(serializeMemory(memory));
    }
  );

  // PATCH /spindle/memories/:id — partial edit.
  app.patch<{ Params: { id: string }; Body: PatchBody }>(
    "/spindle/memories/:id",
    async (request, reply) => {
      const id = toNumber(request.params.id);
      if (id === undefined) {
        return reply.code(400).send({ error: "invalid_id" });
      }

      const body = request.body ?? {};
      const fields: Parameters<MemoryEngine["updateMemory"]>[2] = {};

      if (body.content !== undefined) {
        if (typeof body.content !== "string" || body.content.length === 0) {
          return reply.code(400).send({ error: "invalid_content" });
        }
        fields.content = body.content;
      }
      if (body.kind !== undefined) {
        const kind = asKind(body.kind);
        if (!kind) return reply.code(400).send({ error: "invalid_kind" });
        fields.kind = kind;
      }
      if (body.visibility !== undefined) {
        const visibility = asVisibility(body.visibility);
        if (!visibility) {
          return reply.code(400).send({ error: "invalid_visibility" });
        }
        fields.visibility = visibility;
      }
      if (body.thread_id !== undefined) {
        if (body.thread_id === null) {
          fields.threadId = null;
        } else if (typeof body.thread_id === "string") {
          fields.threadId = body.thread_id;
        } else {
          return reply.code(400).send({ error: "invalid_thread_id" });
        }
      }
      if (body.metadata !== undefined) {
        const metadata = asMetadata(body.metadata);
        if (body.metadata !== null && metadata === undefined) {
          return reply.code(400).send({ error: "invalid_metadata" });
        }
        fields.metadata = metadata;
      }

      if (Object.keys(fields).length === 0) {
        return reply.code(400).send({ error: "no_fields_to_update" });
      }

      let updated;
      try {
        updated = deps.engine.updateMemory(deps.agentId, id, fields);
      } catch (err) {
        return reply.code(400).send({
          error: "update_validation",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      if (!updated) return reply.code(404).send({ error: "memory_not_found" });
      return serializeMemory(updated);
    }
  );

  // DELETE /spindle/memories/:id — soft delete (tombstone).
  app.delete<{ Params: { id: string }; Querystring: { reason?: string } }>(
    "/spindle/memories/:id",
    async (request, reply) => {
      const id = toNumber(request.params.id);
      if (id === undefined) {
        return reply.code(400).send({ error: "invalid_id" });
      }
      const reason =
        typeof request.query.reason === "string" &&
        request.query.reason.length > 0
          ? request.query.reason
          : "operator:web-ui";
      const tombstoned = deps.engine.tombstoneScoped(deps.agentId, id, reason);
      if (!tombstoned) {
        return reply
          .code(404)
          .send({ error: "memory_not_found_or_already_tombstoned" });
      }
      return serializeMemory(tombstoned);
    }
  );

  // POST /spindle/memories/:id/restore — un-tombstone.
  app.post<{ Params: { id: string } }>(
    "/spindle/memories/:id/restore",
    async (request, reply) => {
      const id = toNumber(request.params.id);
      if (id === undefined) {
        return reply.code(400).send({ error: "invalid_id" });
      }
      const restored = deps.engine.restoreScoped(deps.agentId, id);
      if (!restored) {
        return reply
          .code(404)
          .send({ error: "memory_not_found_or_not_tombstoned" });
      }
      return serializeMemory(restored);
    }
  );
}
