/**
 * Visibility scoping for memory queries.
 *
 * Every recall from the `memories` table passes through this helper to
 * build a WHERE clause that respects the three scoping modes:
 *
 *   - private: only the owning agent can read it
 *   - shared:  every agent can read it
 *   - thread:  readable when the caller passes a matching thread_id
 *              (exact) or a matching thread_id prefix (pattern)
 *
 * Security model is "filter, not capability" — see the Phase 2 plan's
 * "Filter model vs capability/security model" section. The engine does
 * not enforce grants or track thread ownership; it just filters.
 */

/**
 * Thread context for a recall.
 *
 *   - `undefined` — caller is not in any thread; thread-scoped memories
 *      are NOT included in the result
 *   - `{ id: "..." }` — exact match on thread_id
 *   - `{ pattern: "..." }` — SQL LIKE pattern (e.g. "audit:nagios:%");
 *      SQLite's query planner uses the thread_id index for
 *      literal-prefix patterns, so this stays fast
 *
 * `id` and `pattern` are mutually exclusive. Passing both throws.
 */
export type ThreadContext =
  | undefined
  | { id: string; pattern?: never }
  | { pattern: string; id?: never };

export interface VisibilityClause {
  /**
   * SQL fragment suitable to be combined with an AND into a larger WHERE.
   * Uses bun:sqlite's `$name` named-parameter syntax. Keys in `params`
   * are `$`-prefixed to match bun:sqlite's binding requirement — you can
   * splat `params` directly into `.all(...)` / `.get(...)`.
   *
   * Heads up: bun:sqlite silently binds NOTHING if you use `:name` or
   * forget the `$` prefix on object keys. Always use this helper rather
   * than constructing clauses by hand.
   */
  clause: string;
  params: Record<string, string>;
}

/**
 * Options for `buildVisibilityClause`.
 */
export interface VisibilityOptions {
  /**
   * When true, the clause does NOT append `AND tombstoned_at IS NULL`.
   * Default false — tombstoned rows are excluded from every normal
   * recall path. Admin / diagnostic callers (e.g. the bulk suggest tool,
   * `listTombstoned`, `getById` with the flag) opt in with `true`.
   */
  includeTombstoned?: boolean;
}

/**
 * Build a visibility WHERE clause for a recall by a given agent.
 *
 * @param agentId  The calling agent's id. Their private memories are
 *                 always included.
 * @param thread   Thread context (see `ThreadContext`).
 * @param options  Optional flags — see `VisibilityOptions`.
 *
 * @throws if `thread` has both `id` and `pattern` set.
 */
export function buildVisibilityClause(
  agentId: string,
  thread?: ThreadContext,
  options?: VisibilityOptions
): VisibilityClause {
  if (
    thread &&
    "id" in thread &&
    "pattern" in thread &&
    thread.id != null &&
    thread.pattern != null
  ) {
    throw new Error(
      "ThreadContext.id and .pattern are mutually exclusive — pass exactly one"
    );
  }

  const parts: string[] = [
    `visibility = 'shared'`,
    `(visibility = 'private' AND agent_id = $agentId)`,
  ];
  const params: Record<string, string> = { $agentId: agentId };

  if (thread) {
    if ("id" in thread && thread.id != null) {
      parts.push(`(visibility = 'thread' AND thread_id = $threadId)`);
      params.$threadId = thread.id;
    } else if ("pattern" in thread && thread.pattern != null) {
      parts.push(`(visibility = 'thread' AND thread_id LIKE $threadPattern)`);
      params.$threadPattern = thread.pattern;
    }
  }

  const visibilityClause = `(${parts.join(" OR ")})`;
  const clause = options?.includeTombstoned
    ? visibilityClause
    : `${visibilityClause} AND tombstoned_at IS NULL`;

  return { clause, params };
}
