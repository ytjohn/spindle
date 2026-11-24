/**
 * An HTTP server for a channel that serves its own API.
 *
 * A plugin lives in another repository with its own dependencies, or
 * none. Handing it the server spindle already ships means it needs no
 * install of its own and cannot end up on a different major version than
 * the bearer-auth hook (./auth.ts) was written for.
 */

import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

export type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export function createHttpServer(options: FastifyServerOptions = { logger: false }): FastifyInstance {
  return Fastify(options);
}
