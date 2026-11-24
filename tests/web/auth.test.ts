import { describe, it, expect } from "vitest";
import {
  constantTimeEquals,
  createBearerAuthPreHandler,
} from "../../src/web/auth";
import type {
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from "fastify";

function makeReqReply(headers: Record<string, string | undefined> = {}) {
  let statusCode: number | undefined;
  let body: unknown;
  let doneCalled = false;
  const reply = {
    code(n: number) {
      statusCode = n;
      return this;
    },
    send(payload: unknown) {
      body = payload;
      return this;
    },
  } as unknown as FastifyReply;
  const request = { headers } as unknown as FastifyRequest;
  const done: HookHandlerDoneFunction = () => {
    doneCalled = true;
  };
  return {
    request,
    reply,
    done,
    status: () => statusCode,
    body: () => body,
    doneCalled: () => doneCalled,
  };
}

describe("constantTimeEquals", () => {
  it("returns true for identical strings", () => {
    expect(constantTimeEquals("hunter2", "hunter2")).toBe(true);
  });

  it("returns false on length mismatch", () => {
    expect(constantTimeEquals("abc", "abcd")).toBe(false);
  });

  it("returns false on same-length mismatch", () => {
    expect(constantTimeEquals("abcdef", "abcdeX")).toBe(false);
  });
});

describe("bearer auth preHandler", () => {
  const handler = createBearerAuthPreHandler("secret-token");

  it("returns 401 when Authorization header is missing", async () => {
    const ctx = makeReqReply({});
    handler(ctx.request, ctx.reply, ctx.done);
    expect(ctx.status()).toBe(401);
    expect(ctx.body()).toMatchObject({ error: "missing_authorization" });
  });

  it("returns 401 when scheme is not Bearer", async () => {
    const ctx = makeReqReply({ authorization: "Basic abc" });
    handler(ctx.request, ctx.reply, ctx.done);
    expect(ctx.status()).toBe(401);
    expect(ctx.body()).toMatchObject({ error: "invalid_authorization_scheme" });
  });

  it("returns 401 when token mismatches", async () => {
    const ctx = makeReqReply({ authorization: "Bearer wrong" });
    handler(ctx.request, ctx.reply, ctx.done);
    expect(ctx.status()).toBe(401);
    expect(ctx.body()).toMatchObject({ error: "invalid_token" });
  });

  it("passes through when token matches", async () => {
    const ctx = makeReqReply({ authorization: "Bearer secret-token" });
    handler(ctx.request, ctx.reply, ctx.done);
    expect(ctx.status()).toBeUndefined();
    expect(ctx.body()).toBeUndefined();
    expect(ctx.doneCalled()).toBe(true);
  });

  it("is case-insensitive on the scheme", async () => {
    const ctx = makeReqReply({ authorization: "bearer secret-token" });
    handler(ctx.request, ctx.reply, ctx.done);
    expect(ctx.status()).toBeUndefined();
    expect(ctx.doneCalled()).toBe(true);
  });
});
