/**
 * Embedding helpers and client.
 *
 * - `Float32Array <-> Buffer` round-trip for BLOB storage
 * - `cosineSimilarity(a, b)` pure function
 * - `EmbeddingClient` thin wrapper around an OpenAI-compatible
 *   `/embeddings` endpoint
 *
 * The client is a stub in Phase 2.0 Task 3 — the engine doesn't use it
 * until Task 5 enables embeddings. Shipping the stub + tests now so
 * Task 5 is pure integration with a known-good helper.
 */

/**
 * Convert a Float32Array to a Buffer suitable for SQLite BLOB storage.
 * Copies the underlying bytes — the result doesn't share the input's
 * buffer so mutating one doesn't affect the other.
 */
export function embeddingToBlob(embedding: Float32Array): Buffer {
  const copy = new Uint8Array(embedding.byteLength);
  copy.set(new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength));
  return Buffer.from(copy);
}

/**
 * Convert a SQLite BLOB back to a Float32Array. Returns null if the
 * input is null/undefined, so callers can pass row.embedding through
 * without a conditional.
 */
export function blobToEmbedding(blob: Buffer | Uint8Array | null | undefined): Float32Array | null {
  if (blob == null) return null;
  // Copy into a fresh ArrayBuffer to avoid tying the Float32Array to the
  // caller's memory (and to sidestep SharedArrayBuffer typing issues).
  const bytes = new Uint8Array(blob.byteLength);
  bytes.set(blob as Uint8Array);
  return new Float32Array(bytes.buffer);
}

/**
 * Cosine similarity between two unit-free vectors, normalizing along
 * the way. Returns a value in [-1, 1]. Returns 0 when either vector
 * is the zero vector (no meaningful direction to compare).
 *
 * Dimensions must match — caller's responsibility.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(
      `cosineSimilarity: dimension mismatch (${a.length} vs ${b.length})`
    );
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ============================================================================
// EmbeddingClient
// ============================================================================

export interface EmbeddingProviderConfig {
  /** e.g. "openai", "vllm", "ollama" — informational, not dispatched on. */
  provider: string;
  /** Model id the provider recognizes. */
  model: string;
  /** Base URL of the OpenAI-compatible endpoint. Defaults to "https://api.openai.com/v1". */
  baseUrl?: string;
  /** Env var to read the API key from. Undefined means no auth header. */
  apiKeyEnv?: string;
  /** Expected dimensions (informational — actual shape comes from the response). */
  dimensions?: number;
}

interface EmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage?: { prompt_tokens: number; total_tokens: number };
}

/**
 * HTTP client for an OpenAI-compatible `/embeddings` endpoint.
 *
 * No retries, no batching in this first cut — callers that want either
 * can wrap. MVP callers will do one embed per store operation, so
 * naive is fine.
 */
export class EmbeddingClient {
  constructor(private readonly config: EmbeddingProviderConfig) {}

  async embed(text: string, signal?: AbortSignal): Promise<Float32Array> {
    const base = this.config.baseUrl ?? "https://api.openai.com/v1";
    const url = `${base.replace(/\/$/, "")}/embeddings`;

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.apiKeyEnv) {
      const key = process.env[this.config.apiKeyEnv];
      if (key) headers.authorization = `Bearer ${key}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.config.model,
        input: text,
      }),
      signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `embedding request failed: ${response.status} ${response.statusText}${body ? `\n${body}` : ""}`
      );
    }

    const payload = (await response.json()) as EmbeddingResponse;
    const vec = payload.data[0]?.embedding;
    if (!vec || !Array.isArray(vec)) {
      throw new Error("embedding response did not include a vector");
    }
    return Float32Array.from(vec);
  }
}
