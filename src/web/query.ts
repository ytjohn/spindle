/**
 * Shared helpers for parsing web query-string params into the shapes
 * engine methods expect. Kept in one place so every route uses the
 * same coercion rules (clamps, defaults, list-splitting) and tests can
 * exercise the edges once.
 */

import type { ListResult } from "../memory/types";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;

export interface PaginationParams {
  limit: number;
  offset: number;
}

export function parsePagination(q: Record<string, unknown>): PaginationParams {
  const limitRaw = toNumber(q.limit);
  const offsetRaw = toNumber(q.offset);
  const limit = Math.min(
    Math.max(1, Math.floor(limitRaw ?? DEFAULT_LIMIT)),
    MAX_LIMIT
  );
  const offset = Math.max(0, Math.floor(offsetRaw ?? 0));
  return { limit, offset };
}

export function parseCommaList(v: unknown): string[] | undefined {
  if (typeof v !== "string" || v.length === 0) return undefined;
  const parts = v
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parts.length > 0 ? parts : undefined;
}

export function parseBool(v: unknown): boolean | undefined {
  if (typeof v !== "string") return undefined;
  const lower = v.toLowerCase();
  if (lower === "true" || lower === "1" || lower === "yes") return true;
  if (lower === "false" || lower === "0" || lower === "no") return false;
  return undefined;
}

/**
 * Accept an ISO-8601 string or a numeric ms. Return ms, or undefined
 * if the input is absent / unparseable.
 */
export function parseTime(v: unknown): number | undefined {
  const n = toNumber(v);
  if (n !== undefined) return n;
  if (typeof v === "string" && v.length > 0) {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

export function toNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.length > 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export function envelope<T, U>(result: ListResult<T>, map: (t: T) => U) {
  return {
    items: result.items.map(map),
    limit: result.limit,
    offset: result.offset,
    total: result.total,
    has_more: result.hasMore,
  };
}
