import { describe, expect, it, vi } from 'vitest';

import {
  ImageGenerationClientError,
  isImageGenerationClientError,
} from './errors.js';
import { createOpenAICompatibleImageReviewClient } from './review-client.js';

const config = {
  baseUrl: 'https://llm.example.test/v1',
  apiKey: 'private-token',
  model: 'gemini-3.1-flash-image',
};

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function jsonBody(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function chatResponse(content: string): Response {
  return jsonBody({
    choices: [{ message: { role: 'assistant', content } }],
  });
}

function readError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined, (reason: unknown) => reason);
}

describe('image review client — happy path', () => {
  it('posts one multimodal chat-completions request with the configured image model', async () => {
    const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      void input;
      void init;
      return chatResponse('{"score":100,"issues":[],"suggestion":""}');
    });
    const client = createOpenAICompatibleImageReviewClient({ config, fetch });

    await client.review({
      imageBytes: PNG_BYTES,
      mimeType: 'image/png',
      brief: 'poster for hari guru',
    });

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      'https://llm.example.test/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer private-token',
          'Content-Type': 'application/json',
        },
      }),
    );

    const call = fetch.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(call.body as string) as {
      model: string;
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(body.model).toBe('gemini-3.1-flash-image');
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]!.role).toBe('system');
    expect(typeof body.messages[0]!.content).toBe('string');
    expect(body.messages[1]!.role).toBe('user');
    const userParts = body.messages[1]!.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(userParts).toHaveLength(2);
    expect(userParts[0]!.type).toBe('text');
    expect(userParts[0]!.text).toBe('poster for hari guru');
    expect(userParts[1]!.type).toBe('image_url');
    expect(userParts[1]!.image_url!.url).toMatch(/^data:image\/png;base64,/);
  });

  it('parses a passing score from strict JSON', async () => {
    const fetch = vi.fn(async () => chatResponse('{"score":100,"issues":[],"suggestion":""}'));
    const client = createOpenAICompatibleImageReviewClient({ config, fetch });

    const result = await client.review({
      imageBytes: PNG_BYTES,
      mimeType: 'image/png',
      brief: 'brief text',
    });

    expect(result.score).toBe(100);
    expect(result.issues).toEqual([]);
    expect(result.suggestion).toBe('');
    expect(result.model).toBe('gemini-3.1-flash-image');
  });

  it('parses a failing score with issues and suggestion', async () => {
    const fetch = vi.fn(async () => chatResponse(
      '{"score":50,"issues":["headline misspelled","wrong language"],"suggestion":"fix headline spelling and use Indonesian"}',
    ));
    const client = createOpenAICompatibleImageReviewClient({ config, fetch });

    const result = await client.review({
      imageBytes: PNG_BYTES,
      mimeType: 'image/png',
      brief: 'brief text',
    });

    expect(result.score).toBe(50);
    expect(result.issues).toEqual(['headline misspelled', 'wrong language']);
    expect(result.suggestion).toBe('fix headline spelling and use Indonesian');
  });

  it('recovers a score from a markdown code fence', async () => {
    const fetch = vi.fn(async () => chatResponse(
      '```json\n{"score":50,"issues":["typo"],"suggestion":"fix"}\n```',
    ));
    const client = createOpenAICompatibleImageReviewClient({ config, fetch });

    const result = await client.review({
      imageBytes: PNG_BYTES,
      mimeType: 'image/png',
      brief: 'brief text',
    });

    expect(result.score).toBe(50);
    expect(result.issues).toEqual(['typo']);
    expect(result.suggestion).toBe('fix');
  });

  it('recovers a score from prose with embedded JSON', async () => {
    const fetch = vi.fn(async () => chatResponse(
      'Here is my review: {"score":50,"issues":["low contrast"],"suggestion":"darker text"} thanks',
    ));
    const client = createOpenAICompatibleImageReviewClient({ config, fetch });

    const result = await client.review({
      imageBytes: PNG_BYTES,
      mimeType: 'image/png',
      brief: 'brief text',
    });

    expect(result.score).toBe(50);
    expect(result.issues).toEqual(['low contrast']);
  });

  it('accepts content as an array of typed parts', async () => {
    const fetch = vi.fn(async () => jsonBody({
      choices: [{
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '{"score":100,"issues":[],"suggestion":""}' },
          ],
        },
      }],
    }));
    const client = createOpenAICompatibleImageReviewClient({ config, fetch });

    const result = await client.review({
      imageBytes: PNG_BYTES,
      mimeType: 'image/png',
      brief: 'brief text',
    });

    expect(result.score).toBe(100);
  });

  it('treats unparseable content as pass (score 100) so the loop does not regenerate forever', async () => {
    const fetch = vi.fn(async () => chatResponse('the image looks fine to me'));
    const client = createOpenAICompatibleImageReviewClient({ config, fetch });

    const result = await client.review({
      imageBytes: PNG_BYTES,
      mimeType: 'image/png',
      brief: 'brief text',
    });

    expect(result.score).toBe(100);
    expect(result.issues).toEqual([]);
  });
});

describe('image review client — input validation', () => {
  it('rejects a blank brief before provider access', async () => {
    const fetch = vi.fn();
    const client = createOpenAICompatibleImageReviewClient({ config, fetch });
    await expect(client.review({
      imageBytes: PNG_BYTES,
      mimeType: 'image/png',
      brief: '   ',
    })).rejects.toThrow('Image generation returned an invalid response.');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a brief over 4,000 UTF-8 bytes', async () => {
    const fetch = vi.fn();
    const client = createOpenAICompatibleImageReviewClient({ config, fetch });
    const long = 'x'.repeat(4_001);
    await expect(client.review({
      imageBytes: PNG_BYTES,
      mimeType: 'image/png',
      brief: long,
    })).rejects.toThrow('Image generation returned an invalid response.');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed with a configuration error when the model is missing', async () => {
    const fetch = vi.fn();
    const client = createOpenAICompatibleImageReviewClient({
      config: { baseUrl: config.baseUrl, apiKey: config.apiKey, model: '' },
      fetch,
    });
    await expect(client.review({
      imageBytes: PNG_BYTES,
      mimeType: 'image/png',
      brief: 'brief',
    })).rejects.toThrow('Image generation is not configured.');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed with a configuration error when the api key is missing', async () => {
    const fetch = vi.fn();
    const client = createOpenAICompatibleImageReviewClient({
      config: { baseUrl: config.baseUrl, apiKey: '', model: config.model },
      fetch,
    });
    await expect(client.review({
      imageBytes: PNG_BYTES,
      mimeType: 'image/png',
      brief: 'brief',
    })).rejects.toThrow('Image generation is not configured.');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed with a configuration error when the base url is missing', async () => {
    const fetch = vi.fn();
    const client = createOpenAICompatibleImageReviewClient({
      config: { baseUrl: '', apiKey: config.apiKey, model: config.model },
      fetch,
    });
    await expect(client.review({
      imageBytes: PNG_BYTES,
      mimeType: 'image/png',
      brief: 'brief',
    })).rejects.toThrow('Image generation is not configured.');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('image review client — provider failure normalization', () => {
  it('maps a 401 to a fixed configuration error and never echoes the body', async () => {
    const fetch = vi.fn(async () => jsonBody(
      { error: 'invalid api key private-token' },
      { status: 401 },
    ));
    const client = createOpenAICompatibleImageReviewClient({ config, fetch });
    const err = await readError(client.review({
      imageBytes: PNG_BYTES,
      mimeType: 'image/png',
      brief: 'brief',
    }));
    expect(isImageGenerationClientError(err)).toBe(true);
    expect((err as ImageGenerationClientError).category).toBe('configuration');
    expect((err as Error).message).not.toContain('private-token');
  });

  it('maps a 500 to a fixed review-failed error', async () => {
    const fetch = vi.fn(async () => jsonBody(
      { error: 'internal', detail: 'upstream down' },
      { status: 500 },
    ));
    const client = createOpenAICompatibleImageReviewClient({ config, fetch });
    const err = await readError(client.review({
      imageBytes: PNG_BYTES,
      mimeType: 'image/png',
      brief: 'brief',
    }));
    expect(isImageGenerationClientError(err)).toBe(true);
    expect((err as ImageGenerationClientError).category).toBe('review-failed');
    expect((err as Error).message).not.toContain('upstream down');
  });

  it('rejects a non-JSON content-type as a format error', async () => {
    const fetch = vi.fn(async () => new Response('<html>nope</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));
    const client = createOpenAICompatibleImageReviewClient({ config, fetch });
    const err = await readError(client.review({
      imageBytes: PNG_BYTES,
      mimeType: 'image/png',
      brief: 'brief',
    }));
    expect(isImageGenerationClientError(err)).toBe(true);
    expect((err as ImageGenerationClientError).category).toBe('format');
  });

  it('rejects a payload without choices as invalid', async () => {
    const fetch = vi.fn(async () => jsonBody({}));
    const client = createOpenAICompatibleImageReviewClient({ config, fetch });
    const err = await readError(client.review({
      imageBytes: PNG_BYTES,
      mimeType: 'image/png',
      brief: 'brief',
    }));
    expect(isImageGenerationClientError(err)).toBe(true);
    expect((err as ImageGenerationClientError).category).toBe('invalid');
  });

  it('treats empty assistant content as pass so review stays advisory', async () => {
    const fetch = vi.fn(async () => chatResponse(''));
    const client = createOpenAICompatibleImageReviewClient({ config, fetch });
    const result = await client.review({
      imageBytes: PNG_BYTES,
      mimeType: 'image/png',
      brief: 'brief',
    });
    expect(result.score).toBe(100);
  });

  it('clamps an oversized issue list to at most five entries', async () => {
    const fetch = vi.fn(async () => chatResponse(
      JSON.stringify({
        score: 50,
        issues: ['one', 'two', 'three', 'four', 'five', 'six', 'seven'],
        suggestion: 'fix everything',
      }),
    ));
    const client = createOpenAICompatibleImageReviewClient({ config, fetch });
    const result = await client.review({
      imageBytes: PNG_BYTES,
      mimeType: 'image/png',
      brief: 'brief',
    });
    expect(result.issues).toHaveLength(5);
    expect(result.issues[0]).toBe('one');
    expect(result.issues[4]).toBe('five');
  });
});
