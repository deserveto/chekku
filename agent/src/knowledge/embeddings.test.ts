import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EmbeddingsError,
  batchEmbedInputs,
  createEmbeddingsClient,
} from './embeddings.js';

const configured = {
  baseUrl: 'http://gateway.test/v1',
  apiKey: 'secret-key',
  model: 'test-embed-model',
};

function jsonResponse(body: unknown, ok = true, contentType = 'application/json') {
  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 500,
    headers: { 'content-type': contentType },
  });
}

function embeddingPayload(inputs: string[], dimension = 4) {
  return {
    data: inputs.map((_, index) => ({ index, embedding: Array.from({ length: dimension }, () => 0.5) })),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('batchEmbedInputs', () => {
  it('splits at the 16-input ceiling', () => {
    const batches = batchEmbedInputs(Array.from({ length: 17 }, () => 'a'.repeat(1000)));
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(16);
    expect(batches[1]).toHaveLength(1);
  });

  it('bounds single inputs to the per-input character ceiling', () => {
    const batches = batchEmbedInputs(['a'.repeat(9000)]);
    expect(batches).toHaveLength(1);
    expect(batches[0][0].length).toBe(8000);
  });

  it('returns no batches for empty input', () => {
    expect(batchEmbedInputs([])).toEqual([]);
  });
});

describe('createEmbeddingsClient', () => {
  it('fails closed when unconfigured', async () => {
    const client = createEmbeddingsClient({ baseUrl: '', model: '' });
    await expect(client.embed(['hello'])).rejects.toMatchObject({
      code: 'configuration',
    } satisfies Partial<EmbeddingsError>);
  });

  it('embeds a batch preserving order and reports the model', async () => {
    const requests: Array<{ url: string; body: { model: string; input: string[] }; auth?: string }> = [];
    const client = createEmbeddingsClient({
      ...configured,
      fetchImpl: async (url, init) => {
        requests.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
          auth: new Headers(init?.headers).get('authorization') ?? undefined,
        });
        return jsonResponse(embeddingPayload(requests[requests.length - 1].body.input));
      },
    });
    const vectors = await client.embed(['satu', 'dua']);
    expect(client.model).toBe('test-embed-model');
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(4);
    expect(requests[0].url).toBe('http://gateway.test/v1/embeddings');
    expect(requests[0].auth).toBe('Bearer secret-key');
    expect(requests[0].body).toMatchObject({ model: 'test-embed-model', input: ['satu', 'dua'] });
  });

  it('omits the authorization header when no key is configured (vLLM-friendly)', async () => {
    let authHeader: string | undefined;
    const client = createEmbeddingsClient({
      baseUrl: 'http://gateway.test/v1',
      apiKey: '',
      model: 'embed',
      fetchImpl: async (_url, init) => {
        authHeader = new Headers(init?.headers).get('authorization') ?? undefined;
        return jsonResponse(embeddingPayload(['x']));
      },
    });
    await client.embed(['x']);
    expect(authHeader).toBeUndefined();
  });

  it('maps HTTP failures to a fixed unavailable error without leaking the URL', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = createEmbeddingsClient({
      ...configured,
      fetchImpl: async () => jsonResponse({ error: { message: 'bad model' } }, false),
    });
    let error: EmbeddingsError | undefined;
    try {
      await client.embed(['x']);
    } catch (caught) {
      error = caught as EmbeddingsError;
    }
    expect(error).toBeInstanceOf(EmbeddingsError);
    expect(error?.code).toBe('unavailable');
    expect(error?.message).not.toContain('gateway.test');
    // The bounded snippet is logged server-side only.
    expect(vi.mocked(console.error)).toHaveBeenCalled();
  });

  it('rejects non-JSON and malformed payloads with a format error', async () => {
    const client = createEmbeddingsClient({
      ...configured,
      fetchImpl: async () => jsonResponse(embeddingPayload(['x']), true, 'text/plain'),
    });
    await expect(client.embed(['x'])).rejects.toMatchObject({ code: 'format' });

    const malformed = createEmbeddingsClient({
      ...configured,
      fetchImpl: async () => jsonResponse({ data: [{ embedding: [1, 'x'] }] }),
    });
    await expect(malformed.embed(['x'])).rejects.toMatchObject({ code: 'format' });
  });

  it('maps aborts to a timeout error', async () => {
    const client = createEmbeddingsClient({
      ...configured,
      timeoutMs: 20,
      fetchImpl: (_url, init) => {
        // Executor form: the workspace TS lib predates Promise.withResolvers.
        return new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          void resolve;
        });
      },
    });
    await expect(client.embed(['x'])).rejects.toMatchObject({ code: 'timeout' });
  });
});
