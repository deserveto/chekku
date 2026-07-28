import { describe, expect, it, vi } from 'vitest';

import {
  ImageGenerationClientError,
  isImageGenerationClientError,
} from './errors.js';
import { createOpenAICompatibleImageClient } from './client.js';

const config = {
  baseUrl: 'https://llm.example.test/v1',
  apiKey: 'private-token',
  model: 'gemini-3.1-flash-image',
};

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function jsonBody(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function b64Response(bytes: Uint8Array): Response {
  return jsonBody({ data: [{ b64_json: base64(bytes) }] });
}

function urlResponse(url: string): Response {
  return jsonBody({ data: [{ url }] });
}

function readError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined, (reason: unknown) => reason);
}

describe('OpenAI-compatible image client — happy path', () => {
  it('posts one fixed request with the configured model and server-owned auth', async () => {
    const fetch = vi.fn(async () => b64Response(PNG_MAGIC));
    const client = createOpenAICompatibleImageClient({
      config: { ...config, endpointPath: '/images/generations' },
      fetch,
    });

    await client.generate({ prompt: 'warm light', aspectRatio: '1:1', imageSize: '1K' });

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      'https://llm.example.test/v1/images/generations',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer private-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gemini-3.1-flash-image',
          prompt: 'warm light',
          n: 1,
          response_format: 'b64_json',
          size: '1024x1024',
        }),
      }),
    );
  });

  it('decodes base64 image bytes and infers the mime type from magic bytes', async () => {
    const fetch = vi.fn(async () => b64Response(PNG_MAGIC));
    const client = createOpenAICompatibleImageClient({ config, fetch });

    const result = await client.generate({ prompt: 'a calm desk' });

    expect(result.imageBytes).toEqual(PNG_MAGIC);
    expect(result.mimeType).toBe('image/png');
    expect(result.model).toBe('gemini-3.1-flash-image');
    expect(result.prompt).toBe('a calm desk');
  });

  it('sniffs jpeg magic bytes when no mime type is declared', async () => {
    const fetch = vi.fn(async () => b64Response(JPEG_MAGIC));
    const client = createOpenAICompatibleImageClient({ config, fetch });

    const result = await client.generate({ prompt: 'morning' });
    expect(result.mimeType).toBe('image/jpeg');
  });

  it('falls back to fetching a provider-returned url through a bounded read', async () => {
    const fetch = vi.fn(async (input: URL | RequestInfo) => {
      if (String(input).endsWith('/images/generations')) {
        return urlResponse('https://cdn.example.test/image.png');
      }
      return new Response(PNG_MAGIC, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    });
    const client = createOpenAICompatibleImageClient({ config, fetch });

    const result = await client.generate({ prompt: 'alt path' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.imageBytes).toEqual(PNG_MAGIC);
    expect(result.mimeType).toBe('image/png');
  });
});

describe('OpenAI-compatible image client — input validation', () => {
  it('rejects a blank prompt before provider access', async () => {
    const fetch = vi.fn();
    const client = createOpenAICompatibleImageClient({ config, fetch });
    await expect(client.generate({ prompt: '   ' })).rejects.toThrow(
      'Image generation returned an invalid response.',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an oversized prompt before provider access', async () => {
    const fetch = vi.fn();
    const client = createOpenAICompatibleImageClient({ config, fetch });
    await expect(client.generate({ prompt: 'x'.repeat(2_001) })).rejects.toThrow(
      'Image generation returned an invalid response.',
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('OpenAI-compatible image client — configuration', () => {
  it.each([
    ['baseUrl', { ...config, baseUrl: '' }],
    ['apiKey', { ...config, apiKey: '' }],
    ['model', { ...config, model: '' }],
  ])('fails closed when %s is missing', async (_label, badConfig) => {
    const fetch = vi.fn();
    const client = createOpenAICompatibleImageClient({ config: badConfig, fetch });
    await expect(client.generate({ prompt: 'hi' })).rejects.toThrow(
      'Image generation is not configured.',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects credentials containing CRLF header injection', async () => {
    const fetch = vi.fn();
    const client = createOpenAICompatibleImageClient({
      config: { ...config, apiKey: 'bad\r\nAuthorization: injected' },
      fetch,
    });
    await expect(client.generate({ prompt: 'hi' })).rejects.toThrow(
      'Image generation is not configured.',
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('OpenAI-compatible image client — provider failures', () => {
  it.each([
    [401, 'Image generation is not configured.'],
    [403, 'Image generation is not configured.'],
    [500, 'Image generation is unavailable. Try again later.'],
    [503, 'Image generation is unavailable. Try again later.'],
  ])('maps HTTP %i to a fixed error', async (status, message) => {
    const fetch = vi.fn(async () => new Response('private body', { status }));
    const client = createOpenAICompatibleImageClient({ config, fetch });
    const error = await readError(client.generate({ prompt: 'hi' }));
    expect(String(error)).toContain(message);
    expect(String(error)).not.toMatch(/private-token|private body|llm\.example\.test/);
  });

  it('rejects a non-json response with a fixed format error', async () => {
    const fetch = vi.fn(async () => new Response('<html>not json</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));
    const client = createOpenAICompatibleImageClient({ config, fetch });
    await expect(client.generate({ prompt: 'hi' })).rejects.toThrow(
      'Image generation returned an unsupported format.',
    );
  });

  it('rejects invalid base64', async () => {
    const fetch = vi.fn(async () => jsonBody({ data: [{ b64_json: '!!!not-base64!!!' }] }));
    const client = createOpenAICompatibleImageClient({ config, fetch });
    await expect(client.generate({ prompt: 'hi' })).rejects.toThrow(
      'Image generation returned an invalid response.',
    );
  });

  it('rejects empty image data', async () => {
    const fetch = vi.fn(async () => jsonBody({ data: [{ b64_json: '' }] }));
    const client = createOpenAICompatibleImageClient({ config, fetch });
    await expect(client.generate({ prompt: 'hi' })).rejects.toThrow(
      'Image generation returned an invalid response.',
    );
  });

  it('rejects an unsupported mime type', async () => {
    const fetch = vi.fn(async () => jsonBody({ data: [{ b64_json: base64(new Uint8Array([1, 2, 3, 4, 5])) }] }));
    const client = createOpenAICompatibleImageClient({ config, fetch });
    await expect(client.generate({ prompt: 'hi' })).rejects.toThrow(
      'Image generation returned an unsupported format.',
    );
  });

  it('rejects a payload with no data array', async () => {
    const fetch = vi.fn(async () => jsonBody({}));
    const client = createOpenAICompatibleImageClient({ config, fetch });
    await expect(client.generate({ prompt: 'hi' })).rejects.toThrow(
      'Image generation returned an invalid response.',
    );
  });

  it('rejects an oversized upstream body', async () => {
    const big = base64(new Uint8Array(16 * 1024 * 1024 + 1).fill(0x41));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ data: [{ b64_json: big }] })));
        controller.close();
      },
    });
    const fetch = vi.fn(async () => new Response(stream, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const client = createOpenAICompatibleImageClient({ config, fetch });
    await expect(client.generate({ prompt: 'hi' })).rejects.toThrow(
      'Image generation returned too much data.',
    );
  });

  it('rejects a decoded image that exceeds the byte cap', async () => {
    const oversized = new Uint8Array(10 * 1024 * 1024 + 1);
    oversized[0] = 0x89;
    oversized[1] = 0x50;
    oversized[2] = 0x4e;
    oversized[3] = 0x47;
    const fetch = vi.fn(async () => b64Response(oversized));
    const client = createOpenAICompatibleImageClient({ config, fetch });
    await expect(client.generate({ prompt: 'hi' })).rejects.toThrow(
      'Image generation returned too much data.',
    );
  });

  it('maps a network failure to a fixed unavailable error', async () => {
    const fetch = vi.fn(async () => { throw new Error('connect ECONNREFUSED llm.internal'); });
    const client = createOpenAICompatibleImageClient({ config, fetch });
    const error = await readError(client.generate({ prompt: 'hi' }));
    expect(String(error)).toContain('Image generation is unavailable. Try again later.');
    expect(String(error)).not.toMatch(/ECONNREFUSED|llm\.internal/);
  });

  it('maps a fetch rejection without leaking the cause', async () => {
    const unsafe = Object.assign(new Error('https://llm.internal token=secret'), {
      credential: 'private-token',
    });
    const fetch = vi.fn(async () => { throw unsafe; });
    const client = createOpenAICompatibleImageClient({ config, fetch });
    const error = await readError(client.generate({ prompt: 'hi' }));
    expect(isImageGenerationClientError(error)).toBe(true);
    expect(JSON.stringify(error)).not.toMatch(/private-token|secret|llm\.internal/);
  });

  it('respects a caller abort signal', async () => {
    const fetch = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      })
    ));
    const client = createOpenAICompatibleImageClient({ config, fetch });
    const controller = new AbortController();
    const promise = client.generate({ prompt: 'hi' }, controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow(/cancelled/);
  });
});

describe('ImageGenerationClientError', () => {
  it('exposes the category and a fixed safe message', () => {
    const error = new ImageGenerationClientError('timeout');
    expect(error.category).toBe('timeout');
    expect(error.message).toBe('Image generation timed out. Try again.');
    expect(isImageGenerationClientError(error)).toBe(true);
    expect(isImageGenerationClientError(new Error('other'))).toBe(false);
  });
});
