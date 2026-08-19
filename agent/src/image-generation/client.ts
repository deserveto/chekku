import { env } from '../config/env.js';
import { parsePublicWebUrl, PublicWebUrlError } from '../mastra/web-reader/url.js';
import {
  ImageGenerationClientError,
  isImageGenerationClientError,
} from './errors.js';
import type {
  ImageGenerationClient,
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageMimeType,
  ImageAspectRatio,
  ImageSize,
} from './types.js';

/**
 * OpenAI-compatible image generation client.
 *
 * Targets the standard OpenAI Images API contract:
 *
 *   POST {LLM_BASE_URL}{endpointPath}   (default /images/generations)
 *   Authorization: Bearer {LLM_API_KEY}
 *   { "model": <LLM_IMAGE_MODEL>, "prompt": <prompt>, "n": 1,
 *     "size": "<w>x<h>", "response_format": "b64_json" }
 *
 *   200 -> { "data": [{ "b64_json": "..." }] }   (preferred)
 *          { "data": [{ "url": "..." }] }        (fallback: fetched once)
 *
 * The model, endpoint, and credentials come only from server configuration and
 * are never accepted from a request. The caller supplies a bounded prompt and
 * optional aspect/size hints; the client validates the returned bytes (base64
 * decode, MIME allowlist, byte cap) and normalizes every provider failure into
 * a fixed safe {@link ImageGenerationClientError}.
 *
 * The endpoint contract assumes the OpenAI Images API standard. If the live
 * RafiqSpace gateway does not implement that contract, only this file needs
 * adjustment — every other layer (tool, storage, metadata, route, agent) is
 * exercised through the {@link ImageGenerationClient} interface and its test
 * doubles.
 */

export interface ImageClientConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  endpointPath?: string;
}

export interface OpenAICompatibleImageClientOptions {
  config?: ImageClientConfig;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  now?: () => number;
}

interface ResolvedImageClientConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  endpointPath: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** Hard cap on the upstream HTTP body before parsing. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;
/** Hard cap on the decoded image payload. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PROMPT_BYTES = 2_000;
const ALLOWED_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

const SIZE_MAP: Record<ImageAspectRatio, Record<ImageSize, string>> = {
  '1:1': { '1K': '1024x1024', '2K': '2048x2048' },
  '4:5': { '1K': '1024x1280', '2K': '2048x2560' },
  '9:16': { '1K': '1080x1920', '2K': '2160x3840' },
  '16:9': { '1K': '1280x720', '2K': '2560x1440' },
};

function resolveConfig(explicit?: ImageClientConfig): ResolvedImageClientConfig {
  const baseUrl = (explicit?.baseUrl ?? env.LLM_BASE_URL).trim().replace(/\/+$/, '');
  const apiKey = (explicit?.apiKey ?? env.LLM_API_KEY).trim();
  const model = (explicit?.model ?? env.LLM_IMAGE_MODEL).trim();
  const endpointPath = ((explicit?.endpointPath ?? env.LLM_IMAGE_ENDPOINT_PATH).trim()
    || '/images/generations');
  return { baseUrl, apiKey, model, endpointPath };
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl.trim().replace(/\/+$/, '')).hostname;
  } catch {
    return '';
  }
}

function requireConfigured(config: ResolvedImageClientConfig): void {
  if (!config.baseUrl || /[\r\n]/.test(config.baseUrl)) {
    throw new ImageGenerationClientError('configuration');
  }
  if (!config.apiKey || /[\r\n]/.test(config.apiKey)) {
    throw new ImageGenerationClientError('configuration');
  }
  if (!config.model || /[\r\n]/.test(config.model)) {
    throw new ImageGenerationClientError('configuration');
  }
  if (!config.endpointPath.startsWith('/') || /[\r\n]/.test(config.endpointPath)) {
    throw new ImageGenerationClientError('configuration');
  }
}

function normalizePrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) {
    throw new ImageGenerationClientError('invalid');
  }
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_PROMPT_BYTES) {
    throw new ImageGenerationClientError('invalid');
  }
  return trimmed;
}

function sizeFor(request: ImageGenerationRequest): string | undefined {
  if (!request.aspectRatio && !request.imageSize) return undefined;
  const aspect = request.aspectRatio ?? '1:1';
  const size = request.imageSize ?? '1K';
  return SIZE_MAP[aspect]?.[size];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function decodeBase64(input: string): Uint8Array {
  // Reject whitespace/control chars inside base64; accept standard base64 only.
  if (!input || /[^A-Za-z0-9+/=]/.test(input)) {
    throw new ImageGenerationClientError('invalid');
  }
  let buffer: Buffer;
  try {
    buffer = Buffer.from(input, 'base64');
  } catch {
    throw new ImageGenerationClientError('invalid');
  }
  if (buffer.byteLength === 0) {
    throw new ImageGenerationClientError('invalid');
  }
  return new Uint8Array(buffer);
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (!body || body.locked) return;
  try {
    void body.cancel().catch(() => undefined);
  } catch {
    // Cleanup must not replace the fixed client error.
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // Cleanup must not replace the fixed client error.
  }
}

function sniffImageMagic(bytes: Uint8Array): ImageMimeType | undefined {
  if (bytes.byteLength >= 4) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      return 'image/png';
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return 'image/jpeg';
    }
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes.byteLength >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
      return 'image/webp';
    }
  }
  return undefined;
}

function inferMimeType(bytes: Uint8Array, declared?: string): ImageMimeType {
  // Trust the actual magic bytes first. A provider/model-declared MIME type is
  // used only as a fallback when no known signature matches, so stored extension,
  // object Content-Type, and served Content-Type always reflect the real bytes
  // (PNG bytes are never persisted or served as image/jpeg).
  const sniffed = sniffImageMagic(bytes);
  if (sniffed) return sniffed;
  const candidate = declared?.split(';')[0]?.trim().toLowerCase();
  if (candidate && ALLOWED_MIME_TYPES.has(candidate)) {
    return candidate as ImageMimeType;
  }
  throw new ImageGenerationClientError('format');
}

function extractFirstEntry(payload: unknown): Record<string, unknown> {
  if (!isPlainObject(payload) || !Array.isArray(payload.data) || payload.data.length === 0) {
    throw new ImageGenerationClientError('invalid');
  }
  const first = payload.data[0];
  if (!isPlainObject(first)) {
    throw new ImageGenerationClientError('invalid');
  }
  return first;
}

const MAX_ERROR_SNIPPET_BYTES = 512;

function scrubSecret(value: string, secret: string): string {
  const trimmed = secret.trim();
  if (!trimmed) return value;
  return value.split(trimmed).join('***');
}

/**
 * Read a bounded snippet of a non-ok response body and log it server-side so
 * an operator can diagnose provider failures (e.g. a 403 model-access denial)
 * without a manual probe. The snippet is scrubbed of the API key and the log
 * never reaches the model or the chat stream — the thrown error stays the
 * fixed, sanitized {@link ImageGenerationClientError}.
 */
async function logProviderFailure(response: Response, apiKey: string): Promise<void> {
  let snippet = '';
  if (response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (total < MAX_ERROR_SNIPPET_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          total += value.byteLength;
        }
      }
      const buf = new Uint8Array(total);
      let off = 0;
      for (const chunk of chunks) {
        buf.set(chunk, off);
        off += chunk.byteLength;
      }
      snippet = new TextDecoder('utf-8', { fatal: false }).decode(buf).replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_SNIPPET_BYTES);
    } catch {
      snippet = '';
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Cleanup must not replace the fixed client error.
      }
      cancelBody(response.body);
    }
  }
  const safe = scrubSecret(snippet, apiKey);
  console.warn(
    `[image-generation] provider returned status ${response.status}${safe ? `: ${safe}` : ''}`,
  );
}

async function readBoundedJson(
  response: Response,
  signal: AbortSignal,
  checkpoint: () => void,
  apiKey: string,
): Promise<unknown> {
  if (!response.ok) {
    await logProviderFailure(response, apiKey);
    throw new ImageGenerationClientError(
      response.status === 401 || response.status === 403 ? 'configuration' : 'unavailable',
    );
  }
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json' && contentType !== 'text/json') {
    cancelBody(response.body);
    throw new ImageGenerationClientError('format');
  }
  if (!response.body) throw new ImageGenerationClientError('invalid');

  const reader = response.body.getReader();
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_BODY_BYTES) {
          cancelReader(reader);
          throw new ImageGenerationClientError('tooLarge');
        }
        chunks.push(value);
      }
      checkpoint();
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    checkpoint();
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(body);
    checkpoint();
    try {
      return JSON.parse(decoded) as unknown;
    } catch {
      throw new ImageGenerationClientError('invalid');
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Cleanup must not replace the fixed client error.
    }
    if (signal.aborted) {
      throw new ImageGenerationClientError(signal.reason === 'timeout' ? 'timeout' : 'cancelled');
    }
  }
}

async function fetchUrlBytes(
  fetchImpl: typeof globalThis.fetch,
  rawUrl: string,
  gatewayHost: string,
  apiKey: string,
  signal: AbortSignal,
  checkpoint: () => void,
): Promise<{ bytes: Uint8Array; contentType?: string }> {
  // The provider echoes the artifact URL in its response body, so treat it as
  // untrusted and re-run the same public-URL guard the web reader applies to a
  // provider-echoed URL. This blocks internal/private/non-public targets before
  // any request leaves the agent host. `redirect: 'error'` alone cannot, because
  // it only blocks redirect chains, not the initial URL.
  let url: URL;
  try {
    url = parsePublicWebUrl(rawUrl);
  } catch (error) {
    if (error instanceof PublicWebUrlError) {
      throw new ImageGenerationClientError('invalid');
    }
    throw error;
  }
  checkpoint();

  // The OpenAI Images API returns public artifact URLs. Forward the gateway
  // credential only when the artifact is hosted on the configured gateway host;
  // never attach the gateway bearer to an arbitrary third-party host.
  const headers: Record<string, string> = { Accept: 'image/*' };
  if (gatewayHost && url.hostname === gatewayHost) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetchImpl(url, {
    method: 'GET',
    redirect: 'error',
    signal,
    headers,
  });
  checkpoint();
  if (!response.ok) {
    await logProviderFailure(response, apiKey);
    throw new ImageGenerationClientError(
      response.status === 401 || response.status === 403 ? 'configuration' : 'unavailable',
    );
  }
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType && !ALLOWED_MIME_TYPES.has(contentType) && !contentType.startsWith('image/')) {
    cancelBody(response.body);
    throw new ImageGenerationClientError('format');
  }
  if (!response.body) throw new ImageGenerationClientError('invalid');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_IMAGE_BYTES) {
          cancelReader(reader);
          throw new ImageGenerationClientError('tooLarge');
        }
        chunks.push(value);
      }
      checkpoint();
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Cleanup must not replace the fixed client error.
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, contentType };
}

async function resolveImageBytes(
  fetchImpl: typeof globalThis.fetch,
  entry: Record<string, unknown>,
  gatewayHost: string,
  apiKey: string,
  request: ImageGenerationRequest,
  signal: AbortSignal,
  checkpoint: () => void,
): Promise<{ bytes: Uint8Array; mimeType: ImageMimeType }> {
  if (typeof entry.b64_json === 'string') {
    checkpoint();
    const bytes = decodeBase64(entry.b64_json);
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new ImageGenerationClientError('tooLarge');
    }
    const mimeType = inferMimeType(bytes, request.mimeType);
    return { bytes, mimeType };
  }
  if (typeof entry.url === 'string') {
    checkpoint();
    const fetched = await fetchUrlBytes(fetchImpl, entry.url, gatewayHost, apiKey, signal, checkpoint);
    if (fetched.bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new ImageGenerationClientError('tooLarge');
    }
    const mimeType = inferMimeType(fetched.bytes, fetched.contentType ?? request.mimeType);
    return { bytes: fetched.bytes, mimeType };
  }
  throw new ImageGenerationClientError('invalid');
}

export function createOpenAICompatibleImageClient(
  options: OpenAICompatibleImageClientOptions = {},
): ImageGenerationClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => performance.now());

  return {
    async generate(request, signal) {
      const config = resolveConfig(options.config);
      requireConfigured(config);
      const prompt = normalizePrompt(request.prompt);
      const gatewayHost = hostOf(config.baseUrl);

      const deadlineAt = now() + timeoutMs;
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      let abortSource: 'cancelled' | 'timeout' | undefined = signal?.aborted ? 'cancelled' : undefined;
      const recordTimeout = () => { abortSource ??= 'timeout'; };
      const recordCancellation = () => { abortSource ??= 'cancelled'; };
      timeoutSignal.addEventListener('abort', recordTimeout, { once: true });
      const callerListenerAdded = Boolean(signal && !signal.aborted);
      if (signal && callerListenerAdded) {
        signal.addEventListener('abort', recordCancellation, { once: true });
      }
      const checkpoint = () => {
        if (now() >= deadlineAt) abortSource ??= 'timeout';
        if (abortSource) throw new ImageGenerationClientError(abortSource);
      };

      const requestSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;

      try {
        checkpoint();
        const body = {
          model: config.model,
          prompt,
          n: 1,
          response_format: 'b64_json',
          ...(sizeFor(request) ? { size: sizeFor(request) } : {}),
        };
        checkpoint();
        const response = await fetchImpl(`${config.baseUrl}${config.endpointPath}`, {
          method: 'POST',
          redirect: 'error',
          signal: requestSignal,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        checkpoint();
        const payload = await readBoundedJson(response, requestSignal, checkpoint, config.apiKey);
        checkpoint();
        const entry = extractFirstEntry(payload);
        checkpoint();
        const { bytes, mimeType } = await resolveImageBytes(
          fetchImpl,
          entry,
          gatewayHost,
          config.apiKey,
          request,
          requestSignal,
          checkpoint,
        );
        checkpoint();

        const result: ImageGenerationResult = {
          imageBytes: bytes,
          mimeType,
          model: config.model,
          prompt,
        };
        return result;
      } catch (error) {
        if (isImageGenerationClientError(error)) throw error;
        if (abortSource) throw new ImageGenerationClientError(abortSource);
        checkpoint();
        throw new ImageGenerationClientError('unavailable');
      } finally {
        timeoutSignal.removeEventListener('abort', recordTimeout);
        if (signal && callerListenerAdded) {
          signal.removeEventListener('abort', recordCancellation);
        }
      }
    },
  };
}

export const imageClient: ImageGenerationClient = createOpenAICompatibleImageClient();
