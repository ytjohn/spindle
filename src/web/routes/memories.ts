import type { FastifyInstance } from "fastify";
import type { MemoryEngine } from "../../memory/engine";
import type { Memory, MemoryKind } from "../../memory/types";
import {
  envelope,
  parseBool,
  parseCommaList,
  parsePagination,
  parseTime,
  toNumber,
} from "../query";

export interface MemoriesRoutesDeps {
  agentId: string;
  engine: MemoryEngine;
}

const VALID_KINDS: ReadonlySet<MemoryKind> = new Set([
  "episodic",
  "semantic",
  "procedural",
]);

export function serializeMemory(m: Memory) {
  return {
    id: m.id,
    agent_id: m.agentId,
    visibility: m.visibility,
    thread_id: m.threadId,
    kind: m.kind,
    content: m.content,
    metadata: m.metadata,
    created_at: m.createdAt,
    last_recalled_at: m.lastRecalledAt,
    recall_count: m.recallCount,
    tombstoned_at: m.tombstonedAt ?? null,
    tombstone_reason: m.tombstoneReason ?? null,
  };
}

export async function registerMemoriesRoutes(
  app: FastifyInstance,
  deps: MemoriesRoutesDeps
): Promise<void> {
  app.get<{ Querystring: Record<string, unknown> }>(
    "/spindle/memories",
    async (request) => {
      const q = request.query;
      const { limit, offset } = parsePagination(q);
      const kindList = parseCommaList(q.kind);
      const kind = kindList
        ? (kindList.filter((k) => VALID_KINDS.has(k as MemoryKind)) as MemoryKind[])
        : undefined;
      const result = deps.engine.listMemories(deps.agentId, {
        q: typeof q.q === "string" ? q.q : undefined,
        kind: kind && kind.length > 0 ? kind : undefined,
        includeTombstoned: parseBool(q.include_tombstoned),
        since: parseTime(q.since),
        until: parseTime(q.until),
        limit,
        offset,
      });
      return envelope(result, serializeMemory);
    }
  );

  app.get<{ Params: { id: string } }>(
    "/spindle/memories/:id",
    async (request, reply) => {
      const id = toNumber(request.params.id);
      if (id === undefined) {
        return reply.code(400).send({ error: "invalid_id" });
      }
      const memory = deps.engine.getMemoryById(deps.agentId, id);
      if (!memory) return reply.code(404).send({ error: "memory_not_found" });
      const links = deps.engine.getLinks(deps.agentId, id);
      return {
        ...serializeMemory(memory),
        neighbors: links.map((l) => ({
          src_id: l.srcId,
          dst_id: l.dstId,
          strength: l.strength,
          effective_strength: l.effectiveStrength,
          created_at: l.createdAt,
          last_reinforced_at: l.lastReinforcedAt,
        })),
      };
    }
  );
}
