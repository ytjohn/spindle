/**
 * Eliza web extension — Phase 4.3 example.
 *
 * Demonstrates:
 *   - registerRoute() with auth: "public" (no token needed)
 *   - registerRoute() with auth: "operator" (bearer token required)
 *   - registerStatic() to serve a small HTML page
 *   - registerHomepage() so the spindle dashboard links here
 *
 * In a real agent (an activity feed, a task surface) this file would
 * import your own data layer and wire up richer endpoints.
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { SpindleRuntime } from "../../src/extensions/runtime";

const startedAt = Date.now();

export async function register(runtime: SpindleRuntime): Promise<void> {
  const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), "public");

  // Homepage registration — shows up as a card on the spindle dashboard.
  runtime.registerHomepage({
    path: "/agent/eliza/",
    title: "Eliza",
    description: "Phase 4.3 example web extension",
  });

  // Public endpoint — no bearer token required. Safe to expose to any
  // client that can reach the server (useful for feed-style data).
  runtime.registerRoute({
    method: "GET",
    path: "/agent/eliza/greet",
    auth: "public",
    async handler(_req, reply) {
      return reply.send({
        greeting: `Hello from ${runtime.agentName ?? runtime.agentId}!`,
        ts: new Date().toISOString(),
      });
    },
  });

  // Operator endpoint — requires the bearer token. Suitable for admin
  // data or anything that shouldn't be world-readable.
  runtime.registerRoute({
    method: "GET",
    path: "/agent/eliza/status",
    auth: "operator",
    async handler(_req, reply) {
      return reply.send({
        agentId: runtime.agentId,
        agentName: runtime.agentName,
        memoryEnabled: runtime.memory !== null,
        inboxEnabled: runtime.inbox !== null,
        uptimeMs: Date.now() - startedAt,
      });
    },
  });

  // Static files — serves public/ at /agent/eliza/ with no auth.
  runtime.registerStatic({
    prefix: "/agent/eliza/",
    root: publicDir,
    auth: "public",
  });
}
