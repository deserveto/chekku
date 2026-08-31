import { env } from '../config/env.js';

/**
 * OpenAI-compatible embeddings client for Knowledge Base ingestion and query
 * embedding. Talks to `${LLM_BASE_URL}/embeddings` — the same server-owned
 * gateway the chat models and the image model use, so no additional provider
 * or key exists. Mirrors the bounded-transport conventions of
 * `agent/src/image-generation/client.ts`: fixed timeout, bounded response
 * body, JSON-only, and error messages that never contain the endpoint URL or
 * credentials.
 *
 * The model comes exclusively from `LLM_EMBEDDING_MODEL`. Empty/unset fails
 * closed with a fixed configuration error — no silent calls to an
 * unconfigured model, mirroring `LLM_IMAGE_MODEL`.
 */

export type EmbeddingsErrorCode = 'configuration' | 'timeout' | 'unavailable' | 'format';

export class EmbeddingsError extends Error {
  constructor(public readonly code: EmbeddingsErrorCode, message: string) {
    super(message);
    this.name = 'EmbeddingsError';
  }
}

export interface EmbeddingsClient {
  /** Embed a bounded batch of inputs, preserving input order. */
  embed(inputs: string[]): Promise<number[][]>;
  /** The configured embedding model id (also stored in payloads/metadata). */
  readonly model: string;
}

export interface EmbeddingsClientConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface ResolvedEmbeddingsConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** Hard cap on the upstream HTTP response body before parsing. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;
/** Max inputs per /embeddings request (standard batch ceiling). */
const BATCH_MAX_INPUTS = 16;
/** Max total characters per request so one huge batch cannot blow the URL. */
const BATCH_MAX_TOTAL_CHARS = 60_000;

/** Fixed ceiling on a single embedded input; longer inputs are sliced. */
export const MAX_EMBED_INPUT_CHARS = 8_000;

function resolveConfig(explicit?: EmbeddingsClientConfig): ResolvedEmbeddingsConfig {
  return {
    baseUrl: (explicit?.baseUrl ?? env.LLM_BASE_URL).replace(/\/+$/, ''),
    apiKey: explicit?.apiKey ?? env.LLM_API_KEY,
    model: explicit?.model ?? env.LLM_EMBEDDING_MODEL,
    fetchImpl: explicit?.fetchImpl ?? fetch,
    timeoutMs: explicit?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

function requireConfigured(config: ResolvedEmbeddingsConfig): void {
  if (!config.baseUrl || !config.model) {
    throw new EmbeddingsError(
      'configuration',
      'Knowledge embeddings are not configured. Set LLM_BASE_URL and LLM_EMBEDDING_MODEL.',
    );
  }
}

/** Split inputs into request batches respecting both ceilings. */
export function batchEmbedInputs(inputs: string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentChars = 0;
  for (const input of inputs) {
    const bounded = input.length > MAX_EMBED_INPUT_CHARS
      ? input.slice(0, MAX_EMBED_INPUT_CHARS)
      : input;
    if (
      current.length > 0
      && (current.length + 1 > BATCH_MAX_INPUTS || currentChars + bounded.length > BATCH_MAX_TOTAL_CHARS)
    ) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(bounded);
    currentChars += bounded.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

interface EmbeddingsApiResponse {
  data?: Array<{ index?: unknown; embedding?: unknown }>;
  error?: { message?: unknown };
}

function parseEmbeddingsResponse(payload: unknown, expectedCount: number): number[][] {
  if (typeof payload !== 'object' || payload === null) {
    throw new EmbeddingsError('format', 'Embeddings response was not a JSON object.');
  }
  const { data } = payload as EmbeddingsApiResponse;
  if (!Array.isArray(data) || data.length !== expectedCount) {
    throw new EmbeddingsError('format', 'Embeddings response data did not match the requested batch.');
  }
  const ordered: Array<{ index: number; vector: number[] }> = [];
  for (let position = 0; position < data.length; position++) {
    const entry = data[position];
    if (typeof entry !== 'object' || entry === null) {
      throw new EmbeddingsError('format', 'Embeddings response contained a malformed entry.');
    }
    const embedding = (entry as { embedding?: unknown }).embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new EmbeddingsError('format', 'Embeddings response contained no vector.');
    }
    const vector: number[] = [];
    for (const value of embedding) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new EmbeddingsError('format', 'Embeddings response contained a non-finite vector value.');
      }
      vector.push(value);
    }
    const index = typeof (entry as { index?: unknown }).index === 'number'
      ? (entry as { index: number }).index
      : position;
    ordered.push({ index, vector });
  }
  ordered.sort((a, b) => a.index - b.index);
  return ordered.map((entry) => entry.vector);
}

async function embedBatch(
  config: ResolvedEmbeddingsConfig,
  inputs: string[],
): Promise<number[][]> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await config.fetchImpl(`${config.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: config.model, input: inputs }),
      signal: controller.signal,
    });
    if (!response.ok) {
      // Fixed-code logging: never echo upstream bodies (they can carry
      // gateway internals); the status is enough to act on.
      console.error(`[knowledge] embeddings request failed: status=${response.status}`);
      throw new EmbeddingsError(
        'unavailable',
        'The embedding model request failed. Verify the gateway and LLM_EMBEDDING_MODEL.',
      );
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new EmbeddingsError('format', 'Embeddings endpoint returned a non-JSON response.');
    }
    const lengthHeader = response.headers.get('content-length');
    if (lengthHeader && Number.parseInt(lengthHeader, 10) > MAX_BODY_BYTES) {
      throw new EmbeddingsError('format', 'Embeddings response exceeded the size limit.');
    }
    const payload: unknown = await response.json();
    return parseEmbeddingsResponse(payload, inputs.length);
  } catch (error) {
    if (error instanceof EmbeddingsError) throw error;
    if (controller.signal.aborted) {
      throw new EmbeddingsError('timeout', 'The embedding model request timed out.');
    }
    throw new EmbeddingsError('unavailable', 'The embedding model request could not be completed.');
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * Create an embeddings client. Configuration resolves from the environment
 * unless overridden — dependency injection keeps every transport behavior
 * testable without network access.
 */
export function createEmbeddingsClient(explicit?: EmbeddingsClientConfig): EmbeddingsClient {
  const config = resolveConfig(explicit);
  return {
    model: config.model,
    async embed(inputs: string[]): Promise<number[][]> {
      requireConfigured(config);
      if (inputs.length === 0) return [];
      const vectors: number[][] = [];
      for (const batch of batchEmbedInputs(inputs)) {
        vectors.push(...await embedBatch(config, batch));
      }
      return vectors;
    },
  };
}
