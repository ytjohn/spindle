import type {
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from "fastify";

export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Build a preHandler that rejects requests missing or failing a
 * `Authorization: Bearer <token>` header. The expected token is
 * captured at plugin-registration time — a rotation requires a
 * spindle restart, which is acceptable for 4.0 (flagged in the plan).
 *
 * Uses the done-callback style (not async) so reply.send() halts the
 * lifecycle cleanly. The async/return-reply pattern triggered
 * ERR_HTTP_HEADERS_SENT unhandled rejections on Bun's Fastify v5 +
 * light-my-request combination even though the response completed
 * correctly.
 */
export function createBearerAuthPreHandler(expectedToken: string) {
  return function bearerAuthPreHandler(
    request: FastifyRequest,
    reply: FastifyReply,
    done: HookHandlerDoneFunction
  ): void {
    const header = request.headers.authorization;
    if (!header || typeof header !== "string") {
      reply.code(401).send({ error: "missing_authorization" });
      return;
    }
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) {
      reply.code(401).send({ error: "invalid_authorization_scheme" });
      return;
    }
    if (!constantTimeEquals(match[1], expectedToken)) {
      reply.code(401).send({ error: "invalid_token" });
      return;
    }
    done();
  };
}
