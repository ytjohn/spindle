import type { FastifyInstance } from "fastify";
import type { MemoryEngine } from "../../memory/engine";
import type { SessionRow, EventRow } from "../../memory/types";
import {
  envelope,
  parseCommaList,
  parsePagination,
  parseTime,
  toNumber,
} from "../query";

export interface SessionsRoutesDeps {
  agentId: string;
  engine: MemoryEngine;
}

function serializeSession(s: SessionRow) {
  return {
    id: s.id,
    agent_id: s.agentId,
    file_path: s.filePath,
    started_at: s.startedAt,
    last_activity_at: s.lastActivityAt,
    event_count: s.eventCount,
    last_ingested_byte_offset: s.lastIngestedByteOffset,
    last_ingest_error: s.lastIngestError,
    last_ingest_error_at: s.lastIngestErrorAt,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}

export function serializeEvent(e: EventRow) {
  return {
    id: e.id,
    agent_id: e.agentId,
    session_id: e.sessionId,
    seq: e.seq,
    byte_offset: e.byteOffset,
    ts: e.ts,
    event_type: e.eventType,
    pi_event_id: e.piEventId,
    parent_id: e.parentId,
    role: e.role,
    model: e.model,
    content_json: e.contentJson,
    content_text: e.contentText,
  };
}

export async function registerSessionsRoutes(
  app: FastifyInstance,
  deps: SessionsRoutesDeps
): Promise<void> {
  app.get<{ Querystring: Record<string, unknown> }>(
    "/spindle/sessions",
    async (request) => {
      const q = request.query;
      const { limit, offset } = parsePagination(q);
      const result = deps.engine.listSessions(deps.agentId, {
        limit,
        offset,
        since: parseTime(q.since),
        until: parseTime(q.until),
        minEvents: toNumber(q.min_events),
      });
      return envelope(result, serializeSession);
    }
  );

  app.get<{ Params: { id: string } }>(
    "/spindle/sessions/:id",
    async (request, reply) => {
      const session = deps.engine.getSession(deps.agentId, request.params.id);
      if (!session) return reply.code(404).send({ error: "session_not_found" });
      return serializeSession(session);
    }
  );

  app.get<{
    Params: { id: string };
    Querystring: Record<string, unknown>;
  }>("/spindle/sessions/:id/events", async (request, reply) => {
    const session = deps.engine.getSession(deps.agentId, request.params.id);
    if (!session) return reply.code(404).send({ error: "session_not_found" });
    const q = request.query;
    const { limit, offset } = parsePagination(q);
    const result = deps.engine.listSessionEvents(
      deps.agentId,
      request.params.id,
      {
        limit,
        offset,
        eventTypes: parseCommaList(q.event_type),
        roles: parseCommaList(q.role),
        since: parseTime(q.since),
        until: parseTime(q.until),
      }
    );
    return envelope(result, serializeEvent);
  });
}
