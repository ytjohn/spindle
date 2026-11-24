import type { FastifyInstance } from "fastify";
import type { WebServerDeps } from "../server";

export async function registerHealthRoute(
  app: FastifyInstance,
  deps: WebServerDeps
): Promise<void> {
  app.get("/health", async () => ({
    ok: true,
    agent_id: deps.agentId,
    version: deps.version,
  }));
}
