import type { FastifyInstance } from "fastify";
import type { Database } from "bun:sqlite";
import type { ContextUsage } from "@earendil-works/pi-coding-agent";
import {
  countCompactEvents,
  countContextStats,
  listRecentCompactEvents,
  listRecentContextStats,
  type CompactEventRow,
  type ContextStatRow,
} from "../../telemetry/store";
import { parsePagination } from "../query";

export interface ContextRoutesDeps {
  agentId: string;
  db: Database;
  /**
   * Live context-usage getter, closed over the main pi session in
   * src/index.ts. Optional so tests that only build the web server
   * (no live session) still get a working /current endpoint — it
   * just falls back to the latest `context_stats` row.
   */
  getContextUsage?: () => ContextUsage | undefined;
  /**
   * Current session id getter (live, from the pi session). Same
   * optional treatment as `getContextUsage` — tests can omit.
   */
  getCurrentSessionId?: () => string | undefined;
}

function serializeStat(row: ContextStatRow) {
  return {
    id: row.id,
    agent_id: row.agent_id,
    session_id: row.session_id,
    session_file: row.session_file,
    turn_index: row.turn_index,
    recorded_at: row.recorded_at,
    ms_since_prompt: row.ms_since_prompt,
    ms_since_first_token: row.ms_since_first_token,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cache_read: row.cache_read,
    cache_write: row.cache_write,
    total_tokens: row.total_tokens,
    context_tokens: row.context_tokens,
    context_window: row.context_window,
    context_percent: row.context_percent,
    tool_calls: row.tool_calls,
    compacted_this_turn: row.compacted_this_turn === 1,
    compact_trigger: row.compact_trigger,
    compact_tokens_before: row.compact_tokens_before,
    error: row.error,
  };
}

function serializeCompactEvent(row: CompactEventRow) {
  return {
    id: row.id,
    agent_id: row.agent_id,
    session_id: row.session_id,
    started_at: row.started_at,
    ended_at: row.ended_at,
    trigger: row.trigger,
    reason: row.reason,
    instructions_source: row.instructions_source,
    tokens_before: row.tokens_before,
    tokens_after: row.tokens_after,
    aborted: row.aborted === 1,
    error: row.error,
  };
}

export async function registerContextRoutes(
  app: FastifyInstance,
  deps: ContextRoutesDeps
): Promise<void> {
  app.get("/spindle/context/current", async () => {
    const live = deps.getContextUsage?.();
    const latestRow = listRecentContextStats(deps.db, deps.agentId, 1)[0];
    const latest = latestRow ? serializeStat(latestRow) : null;
    return {
      live: live
        ? {
            tokens: live.tokens,
            context_window: live.contextWindow,
            percent: live.percent,
          }
        : null,
      session_id: deps.getCurrentSessionId?.() ?? latest?.session_id ?? null,
      latest,
    };
  });

  app.get<{ Querystring: Record<string, unknown> }>(
    "/spindle/context/stats",
    async (request) => {
      const { limit, offset } = parsePagination(request.query);
      const items = listRecentContextStats(
        deps.db,
        deps.agentId,
        limit,
        offset
      ).map(serializeStat);
      const total = countContextStats(deps.db, deps.agentId);
      return {
        items,
        limit,
        offset,
        total,
        has_more: offset + items.length < total,
      };
    }
  );

  app.get<{ Querystring: Record<string, unknown> }>(
    "/spindle/context/compact-events",
    async (request) => {
      const { limit, offset } = parsePagination(request.query);
      const items = listRecentCompactEvents(
        deps.db,
        deps.agentId,
        limit,
        offset
      ).map(serializeCompactEvent);
      const total = countCompactEvents(deps.db, deps.agentId);
      return {
        items,
        limit,
        offset,
        total,
        has_more: offset + items.length < total,
      };
    }
  );
}
