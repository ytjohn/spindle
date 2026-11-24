/**
 * SpindleRuntime — the handle passed to every spindle extension's
 * register() function. Gives extensions access to core engines and
 * the ability to register HTTP routes, static assets, and a homepage
 * link into the operator dashboard.
 *
 * Web binding: after createSpindleRuntime() completes, the runtime is
 * stored at globalThis[Symbol.for("@spindle/web-binding")] so pi
 * extensions (memory, inbox, etc.) can also call registerRoute() if
 * they need HTTP surfaces. The same re-import-safe symbol pattern used
 * by src/memory/binding.ts applies here.
 *
 * Spindle extensions (loaded via agent.yaml `extensions:`) receive the
 * runtime as a direct parameter — they are loaded once by spindle's
 * boot code, not by pi's resource loader, so they don't need globalThis.
 */

import type {
  FastifyRequest,
  FastifyReply,
  FastifyInstance,
  HookHandlerDoneFunction,
} from "fastify";
import FastifyStatic from "@fastify/static";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { MemoryEngine } from "../memory/engine";
import type { InboxEngine } from "../inbox/engine";
import type { WorkerDispatcher } from "./worker-dispatch";

/**
 * Narrow, read-mostly view of the live AgentSession exposed to spindle
 * extensions. Derived from AgentSession via Pick so method signatures
 * never drift from the pi SDK. Enough to: subscribe to the live event
 * stream (text deltas, tool calls, turn/compaction boundaries), inject a
 * user message, and read live token/context usage.
 *
 *   subscribe(listener)        → live event stream (returns unsubscribe)
 *   prompt(text, opts)         → inject a message; response arrives via events
 *   getContextUsage()          → live tokens / context window / percent
 *   getSessionStats()          → current session id + stats
 */
export type AgentSessionHandle = Pick<
  AgentSession,
  "subscribe" | "prompt" | "getContextUsage" | "getSessionStats"
>;

export interface RouteRegistration {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Must start with /agent/{agentId}/  */
  path: string;
  auth: "public" | "operator";
  handler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

export interface StaticRegistration {
  /** URL prefix, must start with /agent/{agentId}/ */
  prefix: string;
  /** Absolute filesystem path to serve files from. */
  root: string;
  auth: "public" | "operator";
}

export interface HomepageRegistration {
  /** URL path the dashboard links to. */
  path: string;
  title: string;
  description?: string;
}

export interface SpindleSessionOpts {
  persona?: string;
}

export interface SpindleRuntime {
  readonly agentId: string;
  readonly agentName?: string;
  readonly agentDir: string;
  readonly memory: MemoryEngine | null;
  readonly inbox: InboxEngine | null;

  /**
   * The live agent session, if one exists (null when the agent runs with
   * no main session). Lets extensions stream the agent's activity and
   * inject messages — the basis for a live web console / chat surface.
   */
  readonly agentSession: AgentSessionHandle | null;

  registerRoute(opts: RouteRegistration): void;
  registerStatic(opts: StaticRegistration): void;
  registerHomepage(opts: HomepageRegistration): void;

  /**
   * Reactive ephemeral-session dispatch. Runs a one-shot prompt on an
   * ephemeral pi session (optionally on a model override, with a tool
   * allowlist and thinking level), off the main session's turn loop, and
   * resolves when it settles. Null when the agent has no shared session
   * deps (e.g. web-disabled boot with no main session). The first consumer
   * is a card-reply worker.
   */
  readonly dispatchWorker: WorkerDispatcher | null;

  /**
   * Not implemented in Phase 4.3 — throws. Declared so extension modules
   * can import the type and prepare for LLM-session use in 4.5+.
   */
  createSession(opts?: SpindleSessionOpts): Promise<never>;

  /** Returns all homepage registrations collected so far. */
  getRegisteredAgents(): HomepageRegistration[];
}

export interface SpindleExtensionModule {
  register(runtime: SpindleRuntime): Promise<(() => Promise<void>) | void>;
}

// ─── Runtime builder ──────────────────────────────────────────────────────────

export interface SpindleRuntimeDeps {
  agentId: string;
  agentName?: string;
  agentDir: string;
  memory: MemoryEngine | null;
  inbox: InboxEngine | null;
  /** Live agent session, if any. Exposed to extensions as runtime.agentSession. */
  agentSession?: AgentSessionHandle | null;
  /**
   * Reactive ephemeral-session dispatcher, if the agent has shared session
   * deps. Exposed to extensions as runtime.dispatchWorker.
   */
  dispatchWorker?: WorkerDispatcher | null;
  /** Fastify instance, already constructed, not yet listening. */
  app: FastifyInstance;
  /** Operator bearer token for auth: "operator" routes. */
  operatorToken: string;
}

// SpindleRuntime already declares getRegisteredAgents(); no separate interface needed.

const WEB_BINDING_KEY = Symbol.for("@spindle/web-binding");
type GlobalSlot = { [WEB_BINDING_KEY]?: SpindleRuntime };

export function getBoundWebRuntime(): SpindleRuntime | null {
  return ((globalThis as unknown as GlobalSlot)[WEB_BINDING_KEY]) ?? null;
}

export function createSpindleRuntime(deps: SpindleRuntimeDeps): SpindleRuntime {
  const { agentId, agentName, agentDir, memory, inbox, agentSession, dispatchWorker, app, operatorToken } = deps;

  const homepages: HomepageRegistration[] = [];

  // Done-callback style (not async) so reply.send() halts the lifecycle
  // cleanly — same reason as src/web/auth.ts createBearerAuthPreHandler.
  const bearerCheck = (
    req: FastifyRequest,
    reply: FastifyReply,
    done: HookHandlerDoneFunction
  ): void => {
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${operatorToken}`) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    done();
  };

  const runtime: SpindleRuntime = {
    agentId,
    agentName,
    agentDir,
    memory,
    inbox,
    agentSession: agentSession ?? null,
    dispatchWorker: dispatchWorker ?? null,

    registerRoute({ method, path, auth, handler }: RouteRegistration) {
      const preHandler = auth === "operator" ? [bearerCheck] : [];
      app.route({ method, url: path, preHandler, handler });
    },

    registerStatic({ prefix, root, auth }: StaticRegistration) {
      // Public: register directly on the app, no auth.
      // Operator: wrap in a scoped plugin with bearerCheck.
      if (auth === "public") {
        app.register(FastifyStatic, {
          root,
          prefix,
          decorateReply: false,
        });
      } else {
        app.register(async (scope) => {
          scope.addHook("preHandler", bearerCheck);
          scope.register(FastifyStatic, {
            root,
            prefix,
            decorateReply: false,
          });
        });
      }
    },

    registerHomepage(opts: HomepageRegistration) {
      homepages.push(opts);
    },

    async createSession(_opts?: SpindleSessionOpts): Promise<never> {
      throw new Error(
        "SpindleRuntime.createSession() is not implemented in Phase 4.3. " +
        "Session factory support is planned for a future phase."
      );
    },

    getRegisteredAgents() {
      return [...homepages];
    },
  };

  // Publish to globalThis so pi extensions can reach the runtime without
  // being wired up through the direct parameter path.
  (globalThis as unknown as GlobalSlot)[WEB_BINDING_KEY] = runtime;

  return runtime;
}

export function resetWebBinding(): void {
  (globalThis as unknown as GlobalSlot)[WEB_BINDING_KEY] = undefined;
}
