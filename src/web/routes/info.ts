import type { FastifyInstance } from "fastify";
import type { WebServerDeps } from "../server";
import { getBoundWebRuntime } from "../../extensions/runtime";

export async function registerInfoRoute(
  app: FastifyInstance,
  deps: WebServerDeps
): Promise<void> {
  app.get("/spindle/info", async () => {
    const info: Record<string, unknown> = {
      agent_id: deps.agentId,
      agent_name: deps.agentName,
      session_file: deps.sessionFile,
      memory_enabled: deps.memoryEnabled,
      daydream_enabled: deps.daydreamEnabled,
      repl_enabled: deps.replEnabled,
      ui_enabled: deps.uiEnabled,
      inbox_enabled: Boolean(deps.inboxEnabled),
      telemetry_enabled: Boolean(deps.telemetryEnabled),
      version: deps.version,
      routes: deps.getMountedRoutes(),
      // Populated at request time from the global web runtime binding so
      // extensions that register after createWebServer() are included.
      registered_agents: getBoundWebRuntime()?.getRegisteredAgents() ?? [],
    };
    if (deps.inboxEngine) {
      info.inbox_mail_root = deps.inboxEngine.getMailRoot();
      info.inbox_operator_mail_root = deps.inboxEngine.getOperatorMailRoot();
      info.inbox_route_count = deps.inboxEngine.listRoutes().length;
    }
    return info;
  });
}
