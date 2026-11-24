import type { FastifyInstance } from "fastify";
import type { MemoryEngine } from "../../memory/engine";
import {
  envelope,
  parseCommaList,
  parsePagination,
  parseTime,
} from "../query";
import { serializeEvent } from "./sessions";

export interface EventsRoutesDeps {
  agentId: string;
  engine: MemoryEngine;
}

export async function registerEventsRoutes(
  app: FastifyInstance,
  deps: EventsRoutesDeps
): Promise<void> {
  app.get<{ Querystring: Record<string, unknown> }>(
    "/spindle/events",
    async (request) => {
      const q = request.query;
      const { limit, offset } = parsePagination(q);
      const result = deps.engine.searchEvents(deps.agentId, {
        q: typeof q.q === "string" ? q.q : undefined,
        sessionId: typeof q.session_id === "string" ? q.session_id : undefined,
        eventTypes: parseCommaList(q.event_type),
        roles: parseCommaList(q.role),
        since: parseTime(q.since),
        until: parseTime(q.until),
        limit,
        offset,
      });
      return envelope(result, serializeEvent);
    }
  );
}
