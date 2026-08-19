import { env } from '../config/env.js';
import {
  ImageGenerationClientError,
  isImageGenerationClientError,
} from './errors.js';
import type {
  ImageReviewClient,
  ImageReviewRequest,
  ImageReviewResult,
  ImageMimeType,
} from './types.js';

/**
 * Multimodal image review client.
 *
 * Invokes the same fixed image model (`LLM_IMAGE_MODEL`) used for generation,
 * but through the chat-completions endpoint with an `image_url` content part.
 * The model inspects the generated image against a brief (the canonical
 * content + the agreed visual concept) and returns a structured verdict:
 *
 *   POST {LLM_BASE_URL}/chat/completions
 *   Authorization: Bearer {LLM_API_KEY}
 *   { "model": <LLM_IMAGE_MODEL>,
 *     "messages": [
 *       { "role": "system", "content": "<fixed review instruction>" },
 *       { "role": "user", "content": [
 *           { "type": "text", "text": "<brief>" },
 *           { "type": "image_url",
 *             "image_url": { "url": "data:<mime>;base64,<...>" } }
 *       ] }
 *     ] }
 *
 *   200 -> { "choices": [{ "message": { "content": "<json>" } }] }
 *
 * The model id, endpoint base, and credentials come only from server
 * configuration and are never accepted from a request. The caller supplies a
 * bounded brief and the already-generated image bytes; the client validates
 * the returned verdict JSON and normalizes every provider failure into a fixed
 * safe {@link ImageGenerationClientError} of category `review-failed`.
 *
 * Review is advisory: the orchestration agent decides whether to regenerate.
 * Review never mutates the image, the post, or the persisted asset.
 */

export interface ImageReviewClientConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface OpenAICompatibleImageReviewClientOptions {
  config?: ImageReviewClientConfig;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  now?: () => number;
}

interface ResolvedImageReviewClientConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** Hard cap on the upstream HTTP body before parsing. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;
/** Hard cap on the brief text supplied by the caller. */
const MAX_BRIEF_BYTES = 4_000;
/** Hard cap on the assistant content text we are willing to parse. */
const MAX_CONTENT_BYTES = 4_096;
/** Maximum number of issues kept in the normalized verdict. */
const MAX_ISSUES = 5;
/** Per-issue UTF-8 byte cap. Longer issues are truncated. */
const MAX_ISSUE_BYTES = 2_000;
/** Suggestion UTF-8 byte cap. */
const MAX_SUGGESTION_BYTES = 2_000;

const FIXED_SYSTEM_INSTRUCTION = [
  'You review a generated social-media visual against a brief.',
  'Reply with STRICT JSON only — no markdown, no prose, no code fences.',
  'Shape: {"score":number,"issues":[string,...],"suggestion":string}',
  '- Evaluate based on: composition, hierarchy, premium feeling, brand consistency, storytelling impact.',
  '- Checklist for premium editorial style:',
  '  1. Does it look like a premium technology magazine cover?',
  '  2. Is the hero image realistic (cinematic, proper proportions, not squashed)?',
  '  3. Is the typography clean, hierarchical, and readable?',
  '  4. Is there unnecessary UI decoration (e.g. glass panels, dashboard looks)? Reject if so.',
  '  5. Is branding clean and not duplicated?',
  '  6. Does the composition feel intentional (left: typography, right: hero image)?',
  '- score: 0 to 100 rating of the visual quality.',
  '- issues: at most 5 short actionable strings, each describing one defect.',
  '- suggestion: ONE concise instruction the generator can append to its',
  '  prompt to fix the issues on a regeneration. Empty string if score >= 85.',
].join('\n');

function resolveConfig(explicit?: ImageReviewClientConfig): ResolvedImageReviewClientConfig {
  const baseUrl = (explicit?.baseUrl ?? env.LLM_BASE_URL).trim().replace(/\/+$/, '');
  const apiKey = (explicit?.apiKey ?? env.LLM_API_KEY).trim();
  const model = (explicit?.model ?? env.LLM_IMAGE_MODEL).trim();
  return { baseUrl, apiKey, model };
}

function requireConfigured(config: ResolvedImageReviewClientConfig): void {
  if (!config.baseUrl || /[\r\n]/.test(config.baseUrl)) {
    throw new ImageGenerationClientError('configuration');
  }
  if (!config.apiKey || /[\r\n]/.test(config.apiKey)) {
    throw new ImageGenerationClientError('configuration');
  }
  if (!config.model || /[\r\n]/.test(config.model)) {
    throw new ImageGenerationClientError('configuration');
  }
}

function normalizeBrief(brief: string): string {
  const trimmed = brief.trim();
  if (!trimmed) {
    throw new ImageGenerationClientError('invalid');
  }
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_BRIEF_BYTES) {
    throw new ImageGenerationClientError('invalid');
  }
  return trimmed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function toDataUrl(bytes: Uint8Array, mimeType: ImageMimeType): string {
  const base64 = Buffer.from(bytes).toString('base64');
  return `data:${mimeType};base64,${base64}`;
}

function clampUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  // Truncate by characters, then verify byte length. Slicing by half each
  // iteration bounds this to log2(length) steps for pathological inputs.
  let lo = 0;
  let hi = value.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (Buffer.byteLength(value.slice(0, mid), 'utf8') <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return value.slice(0, lo);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) {
      out.push(clampUtf8(item.trim(), MAX_ISSUE_BYTES));
      if (out.length >= MAX_ISSUES) break;
    }
  }
  return out;
}

function extractVerdict(content: unknown): { score: number; issues: string[]; suggestion: string } {
  const text = asString(content).trim();
  if (!text) {
    // Empty content — accept the image rather than block on a flaky reviewer.
    return { score: 100, issues: [], suggestion: '' };
  }
  const parsed = tryParseVerdictJson(text);
  if (parsed) {
    const score = typeof parsed.score === 'number' ? parsed.score : 100;
    const isFail = score < 85;
    const issues = isFail ? asStringArray(parsed.issues) : [];
    const suggestion = isFail ? clampUtf8(asString(parsed.suggestion).trim(), MAX_SUGGESTION_BYTES) : '';
    return { score, issues, suggestion };
  }
  // Could not parse a structured verdict — treat as pass so the loop does not
  // regenerate forever on a reviewer that ignored the JSON contract. The
  // caller still has the original image; a human can request a revision.
  return { score: 100, issues: [], suggestion: '' };
}

function tryParseVerdictJson(text: string): { score?: unknown; issues?: unknown; suggestion?: unknown } | undefined {
  const direct = tryJson(text);
  if (direct && isPlainObject(direct)) return direct;
  // Recover JSON from a markdown code fence if the model ignored the contract.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    const inner = tryJson(fenced[1] ?? '');
    if (inner && isPlainObject(inner)) return inner;
  }
  // Recover the first {...} blob if the model prefixed prose.
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) {
    const sliced = tryJson(text.slice(first, last + 1));
    if (sliced && isPlainObject(sliced)) return sliced;
  }
  return undefined;
}

function tryJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const MAX_ERROR_SNIPPET_BYTES = 512;

function scrubSecret(value: string, secret: string): string {
  const trimmed = secret.trim();
  if (!trimmed) return value;
  return value.split(trimmed).join('***');
}

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
    `[image-review] provider returned status ${response.status}${safe ? `: ${safe}` : ''}`,
  );
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

async function readBoundedJson(
  response: Response,
  signal: AbortSignal,
  checkpoint: () => void,
  apiKey: string,
): Promise<unknown> {
  if (!response.ok) {
    await logProviderFailure(response, apiKey);
    throw new ImageGenerationClientError(
      response.status === 401 || response.status === 403 ? 'configuration' : 'review-failed',
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

function extractAssistantContent(payload: unknown): unknown {
  if (!isPlainObject(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0) {
    throw new ImageGenerationClientError('invalid');
  }
  const first = payload.choices[0];
  if (!isPlainObject(first) || !isPlainObject(first.message)) {
    throw new ImageGenerationClientError('invalid');
  }
  const content = (first.message as Record<string, unknown>).content;
  if (typeof content === 'string') return clampUtf8(content, MAX_CONTENT_BYTES);
  // Some providers return content as an array of typed parts; concatenate the
  // text parts so the verdict parser still receives a plain string.
  if (Array.isArray(content)) {
    let text = '';
    for (const part of content) {
      if (isPlainObject(part) && typeof part.text === 'string') {
        text += part.text;
      }
    }
    return clampUtf8(text, MAX_CONTENT_BYTES);
  }
  throw new ImageGenerationClientError('invalid');
}

export function createOpenAICompatibleImageReviewClient(
  options: OpenAICompatibleImageReviewClientOptions = {},
): ImageReviewClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => performance.now());

  return {
    async review(request, signal) {
      const config = resolveConfig(options.config);
      requireConfigured(config);
      const brief = normalizeBrief(request.brief);

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
          messages: [
            { role: 'system', content: FIXED_SYSTEM_INSTRUCTION },
            {
              role: 'user',
              content: [
                { type: 'text', text: brief },
                {
                  type: 'image_url',
                  image_url: { url: toDataUrl(request.imageBytes, request.mimeType) },
                },
              ],
            },
          ],
        };
        checkpoint();
        const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
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
        const content = extractAssistantContent(payload);
        checkpoint();
        const { score, issues, suggestion } = extractVerdict(content);

        const result: ImageReviewResult = {
          score,
          issues,
          suggestion,
          model: config.model,
        };
        return result;
      } catch (error) {
        if (isImageGenerationClientError(error)) throw error;
        if (abortSource) throw new ImageGenerationClientError(abortSource);
        checkpoint();
        throw new ImageGenerationClientError('review-failed');
      } finally {
        timeoutSignal.removeEventListener('abort', recordTimeout);
        if (signal && callerListenerAdded) {
          signal.removeEventListener('abort', recordCancellation);
        }
      }
    },
  };
}

export const imageReviewClient: ImageReviewClient = createOpenAICompatibleImageReviewClient();
