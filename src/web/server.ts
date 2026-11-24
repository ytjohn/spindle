/**
 * Phase 4.0 Web API — walking skeleton.
 *
 * Route-ownership convention (reservations, not all wired yet):
 *   /health                         — liveness, no auth. Wired.
 *   /spindle/*                      — spindle-core routes, auth required.
 *                                     4.0 ships /spindle/info. 4.1 will
 *                                     add /spindle/sessions,
 *                                     /spindle/memories.
 *   /agent/{name}/*                 — reserved for extension-registered
 *                                     routes (Phase 4.2). 4.0 returns 404.
 *   /api/v1/spindle/*               — reserved for machine-readable API
 *                                     versioning. 4.0 returns 404.
 *   /api/v1/agent/{name}/*          — same, for agent extensions.
 *
 * Boot-order note: the web server starts AFTER daydream init and
 * BEFORE the stdin REPL (`src/index.ts`). This ordering is load-bearing
 * only in the sense that web-enabled agents can still accept stdin, so
 * don't move it earlier in the sequence.
 *
 * Future-binding note: when Phase 4.2 adds agent-registered routes,
 * the Fastify instance must be exposed via
 * `globalThis[Symbol.for("@spindle/web-binding")]`, not a module-level
 * `let`. Pi re-imports extension modules for fresh resourceLoaders
 * (see `src/memory/binding.ts` for the rationale). Walking skeleton
 * doesn't need this yet — flag here so the next author doesn't
 * accidentally reach for a module-level singleton.
 */

import Fastify, { type FastifyInstance } from "fastify";
import FastifyStatic from "@fastify/static";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { existsSync } from "fs";
import type { AgentConfig } from "../types";
import type { MemoryEngine } from "../memory/engine";
import type { InboxEngine } from "../inbox/engine";
import type { ContextUsage } from "@earendil-works/pi-coding-agent";
import { createBearerAuthPreHandler } from "./auth";
import { registerHealthRoute } from "./routes/health";
import { registerInfoRoute } from "./routes/info";
import { registerSessionsRoutes } from "./routes/sessions";
import { registerEventsRoutes } from "./routes/events";
import { registerMemoriesRoutes } from "./routes/memories";
import { registerMemoriesCrudRoutes } from "./routes/memories-crud";
import { registerContextRoutes } from "./routes/context";
import {
  registerInboxRoutes,
  registerOutboxRoutes,
  registerDraftRoutes,
  registerAgentRoutesRoutes,
} from "./routes/inbox";

export interface WebServerDeps {
  agentId: string;
  agentName?: string;
  sessionFile?: string;
  memoryEnabled: boolean;
  daydreamEnabled: boolean;
  replEnabled: boolean;
  uiEnabled: boolean;
  version: string;
  /**
   * Memory engine handle. Required when list/search routes are
   * mounted (Phase 4.1+). Null when memory is disabled — those routes
   * then stay unregistered and 404 instead of crashing.
   */
  engine: MemoryEngine | null;
  /**
   * Inbox engine handle (Phase 4.4a). Null when inbox is disabled —
   * /spindle/inbox, /spindle/outbox, /spindle/drafts, /spindle/routes
   * stay unregistered and 404 instead of crashing.
   */
  inboxEngine?: InboxEngine | null;
  inboxEnabled?: boolean;
  /**
   * Whether context telemetry is recording on this spindle. Gates
   * the /spindle/context/* routes — when false (or when `engine` is
   * null so the DB isn't available), the routes stay unregistered
   * and return 404 instead of misleading empty data.
   */
  telemetryEnabled?: boolean;
  /**
   * Live pi context-usage getter. Closes over the main AgentSession
   * in src/index.ts. Optional — /spindle/context/current falls back
   * to the latest `context_stats` row when this isn't wired (tests).
   */
  getContextUsage?: () => ContextUsage | undefined;
  /** Live pi session id getter — paired with getContextUsage. */
  getCurrentSessionId?: () => string | undefined;
  /**
   * Introspection hook returned to /spindle/info so future UIs can
   * discover the mounted route surface without hardcoding.
   */
  getMountedRoutes: () => string[];
}

export interface WebServerHandle {
  app: FastifyInstance;
  port: number;
  host: string;
  stop: () => Promise<void>;
}

export interface ResolvedWebConfig {
  enabled: boolean;
  host: string;
  port: number;
  tokenEnv: string;
  token: string;
  uiEnabled: boolean;
}

/**
 * Validate the web block and materialize a resolved config. Returns
 * null when `web` is missing or `enabled !== true` so callers can skip
 * boot silently. Throws with a clear message when the config is on but
 * invalid — caller is expected to surface the error and exit.
 */
export function resolveWebConfig(
  config: AgentConfig,
  env: NodeJS.ProcessEnv = process.env
): ResolvedWebConfig | null {
  const web = config.web;
  if (!web || web.enabled !== true) return null;

  const host = web.bind_host ?? "127.0.0.1";
  const port = web.port;
  if (typeof port !== "number") {
    throw new Error("web.enabled=true requires web.port to be set");
  }

  const tokenEnv = web.token_env ?? "SPINDLE_WEB_TOKEN";
  const token = env[tokenEnv];
  if (!token || token.length === 0) {
    throw new Error(
      `web.enabled=true but env var ${tokenEnv} is unset or empty — refusing to boot without auth`
    );
  }

  const uiEnabled = web.ui_enabled !== false;

  return { enabled: true, host, port, tokenEnv, token, uiEnabled };
}

/**
 * Resolve the static UI asset root. Lives at `src/web/public/` in the
 * repo; `import.meta.url` keeps it stable across installed locations.
 * Returns null if the directory is absent (e.g. a minimal install
 * that stripped the UI bundle) — caller skips static registration.
 */
function resolveUiRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolve(here, "public");
  return existsSync(candidate) ? candidate : null;
}

/**
 * Construct a Fastify instance with the 4.0 route set. Does not
 * listen — caller invokes `.listen()` via `startWebServer`. Separated
 * so tests can inject a no-listen app for route assertions.
 */
export function createWebServer(
  resolved: ResolvedWebConfig,
  deps: Omit<WebServerDeps, "getMountedRoutes">
): FastifyInstance {
  const app = Fastify({
    logger: false,
    bodyLimit: 25 * 1024 * 1024, // 25 MB cap on request bodies (attachments)
    // Fastify 5 defaults this to "idle": close() reaps idle keep-alives but
    // WAITS on any connection with a request in flight. A client that holds a
    // long-lived connection to this API made that wait never end, and
    // shutdown hung for systemd's full 90s TimeoutStopSec on every restart —
    // which SIGKILLed ephemeral sessions mid-write and stranded the tasks
    // they had claimed. Shutting down means shutting down: drop the sockets.
    forceCloseConnections: true,
  });

  // Register a raw-Buffer parser for binary uploads (draft attachments in
  // Phase 4.4c). Fastify's default only parses application/json +
  // text/plain; anything else hits "no suitable content type parser".
  // Pattern: parseAs:"buffer" returns the raw Buffer to the route handler.
  // Limited to the octet-stream + common binary/image/pdf content types
  // so misrouted JSON still fails fast with a clear parser error.
  for (const ct of [
    "application/octet-stream",
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/svg+xml",
  ]) {
    app.addContentTypeParser(
      ct,
      { parseAs: "buffer" },
      (_req, body, done) => done(null, body)
    );
  }

  const mountedRoutes: string[] = [];
  const track = (method: string, path: string) => {
    mountedRoutes.push(`${method} ${path}`);
  };

  const depsWithRoutes: WebServerDeps = {
    ...deps,
    getMountedRoutes: () => [...mountedRoutes],
  };

  app.addHook("onRoute", (routeOptions) => {
    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method];
    for (const m of methods) {
      track(String(m), routeOptions.url);
    }
  });

  registerHealthRoute(app, depsWithRoutes);

  const bearerPreHandler = createBearerAuthPreHandler(resolved.token);
  app.register(async (authed) => {
    authed.addHook("preHandler", bearerPreHandler);
    await registerInfoRoute(authed, depsWithRoutes);
    if (deps.engine) {
      await registerSessionsRoutes(authed, {
        agentId: deps.agentId,
        engine: deps.engine,
      });
      await registerEventsRoutes(authed, {
        agentId: deps.agentId,
        engine: deps.engine,
      });
      await registerMemoriesRoutes(authed, {
        agentId: deps.agentId,
        engine: deps.engine,
      });
      await registerMemoriesCrudRoutes(authed, {
        agentId: deps.agentId,
        engine: deps.engine,
      });
      if (deps.telemetryEnabled) {
        await registerContextRoutes(authed, {
          agentId: deps.agentId,
          db: deps.engine.getDb(),
          getContextUsage: deps.getContextUsage,
          getCurrentSessionId: deps.getCurrentSessionId,
        });
      }
    }
    if (deps.inboxEngine) {
      await registerInboxRoutes(authed, {
        agentId: deps.agentId,
        engine: deps.inboxEngine,
      });
      await registerOutboxRoutes(authed, {
        agentId: deps.agentId,
        engine: deps.inboxEngine,
      });
      await registerDraftRoutes(authed, {
        agentId: deps.agentId,
        engine: deps.inboxEngine,
      });
      await registerAgentRoutesRoutes(authed, {
        agentId: deps.agentId,
        engine: deps.inboxEngine,
      });
    }
  });

  // UI static files. No auth on the assets — the token is only used
  // by the page's fetch calls to the API. Register AFTER API routes so
  // the route table wins on overlapping prefixes; `/spindle/*`,
  // `/agent/*`, and `/api/v1/*` are untouched by @fastify/static.
  if (resolved.uiEnabled) {
    const uiRoot = resolveUiRoot();
    if (uiRoot) {
      app.register(FastifyStatic, {
        root: uiRoot,
        prefix: "/",
        decorateReply: false,
      });
    }
  }

  return app;
}

/**
 * Boot the web server. Caller is responsible for calling the returned
 * `.stop()` from the shutdown path — spindle's SIGINT handler does
 * this today.
 */
export async function startWebServer(
  resolved: ResolvedWebConfig,
  deps: Omit<WebServerDeps, "getMountedRoutes">
): Promise<WebServerHandle> {
  const app = createWebServer(resolved, deps);
  await app.listen({ host: resolved.host, port: resolved.port });
  return {
    app,
    port: resolved.port,
    host: resolved.host,
    stop: async () => {
      await app.close();
    },
  };
}
