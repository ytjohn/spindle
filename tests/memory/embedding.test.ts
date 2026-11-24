import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  embeddingToBlob,
  blobToEmbedding,
  cosineSimilarity,
  EmbeddingClient,
} from "../../src/memory/embedding";

describe("embeddingToBlob / blobToEmbedding", () => {
  it("round-trips a simple Float32Array", () => {
    const v = Float32Array.from([1, 2, 3, 4, 5]);
    const blob = embeddingToBlob(v);
    const back = blobToEmbedding(blob);
    expect(back).toBeInstanceOf(Float32Array);
    expect(Array.from(back!)).toEqual([1, 2, 3, 4, 5]);
  });

  it("round-trips a fractional vector with many dimensions", () => {
    const v = Float32Array.from(
      Array.from({ length: 384 }, (_, i) => Math.sin(i) * 0.5)
    );
    const back = blobToEmbedding(embeddingToBlob(v));
    expect(back?.length).toBe(384);
    // Floats are exactly representable across the round-trip
    for (let i = 0; i < v.length; i++) {
      expect(back![i]).toBe(v[i]);
    }
  });

  it("blobToEmbedding returns null for null input", () => {
    expect(blobToEmbedding(null)).toBeNull();
    expect(blobToEmbedding(undefined)).toBeNull();
  });

  it("the round-trip doesn't share memory with the source", () => {
    const v = Float32Array.from([1, 2, 3]);
    const back = blobToEmbedding(embeddingToBlob(v))!;
    back[0] = 999;
    expect(v[0]).toBe(1);
  });
});

describe("cosineSimilarity", () => {
  it("identity: a vector with itself is 1", () => {
    const v = Float32Array.from([1, 2, 3, 4]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 6);
  });

  it("orthogonal vectors give 0", () => {
    const a = Float32Array.from([1, 0]);
    const b = Float32Array.from([0, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 6);
  });

  it("anti-parallel vectors give -1", () => {
    const a = Float32Array.from([1, 0]);
    const b = Float32Array.from([-1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 6);
  });

  it("zero vector gives 0 (no direction)", () => {
    const a = Float32Array.from([0, 0, 0]);
    const b = Float32Array.from([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
    expect(cosineSimilarity(b, a)).toBe(0);
  });

  it("normalizes magnitude — scaling one vector doesn't change similarity", () => {
    const a = Float32Array.from([1, 2, 3]);
    const b = Float32Array.from([1, 2, 3]);
    const scaled = Float32Array.from([100, 200, 300]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(a, scaled), 6);
  });

  it("throws on dimension mismatch", () => {
    const a = Float32Array.from([1, 2, 3]);
    const b = Float32Array.from([1, 2]);
    expect(() => cosineSimilarity(a, b)).toThrow(/dimension mismatch/);
  });
});

describe("EmbeddingClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to {baseUrl}/embeddings with the correct body", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
            model: "text-embedding-3-small",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchFn);

    const client = new EmbeddingClient({
      provider: "openai",
      model: "text-embedding-3-small",
      baseUrl: "http://localhost:8001/v1",
    });
    const vec = await client.embed("hello world");
    expect(vec).toBeInstanceOf(Float32Array);
    expect(Array.from(vec)).toEqual([
      Math.fround(0.1),
      Math.fround(0.2),
      Math.fround(0.3),
    ]);

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:8001/v1/embeddings");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ model: "text-embedding-3-small", input: "hello world" });
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
  });

  it("strips trailing slash from baseUrl", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: [{ embedding: [0], index: 0 }], model: "m" }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchFn);

    const client = new EmbeddingClient({
      provider: "vllm",
      model: "m",
      baseUrl: "http://localhost:8001/v1/",
    });
    await client.embed("x");
    expect((fetchFn.mock.calls[0] as [string, unknown])[0]).toBe(
      "http://localhost:8001/v1/embeddings"
    );
  });

  it("adds Authorization header when apiKeyEnv is set and the env var has a value", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: [{ embedding: [0], index: 0 }], model: "m" }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchFn);
    const prev = process.env.TEST_EMBED_KEY;
    process.env.TEST_EMBED_KEY = "sk-test-123";
    try {
      const client = new EmbeddingClient({
        provider: "openai",
        model: "text-embedding-3-small",
        baseUrl: "http://localhost/v1",
        apiKeyEnv: "TEST_EMBED_KEY",
      });
      await client.embed("x");
      const headers = (fetchFn.mock.calls[0] as [string, RequestInit])[1]
        .headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer sk-test-123");
    } finally {
      if (prev === undefined) delete process.env.TEST_EMBED_KEY;
      else process.env.TEST_EMBED_KEY = prev;
    }
  });

  it("throws a useful error on non-2xx responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("boom", {
            status: 500,
            statusText: "Internal Server Error",
          })
      )
    );
    const client = new EmbeddingClient({
      provider: "openai",
      model: "m",
      baseUrl: "http://localhost/v1",
    });
    await expect(client.embed("x")).rejects.toThrow(/500/);
  });

  it("throws when response body has no vector", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [], model: "m" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
      )
    );
    const client = new EmbeddingClient({
      provider: "openai",
      model: "m",
      baseUrl: "http://localhost/v1",
    });
    await expect(client.embed("x")).rejects.toThrow(/no.*vector/i);
  });
});
