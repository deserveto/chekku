import { parsePublicWebUrl, PublicWebUrlError } from './url.js';

export interface WebReaderOutput {
  requestedUrl: string;
  sourceUrl: string;
  title: string;
  markdown: string;
  contentIsUntrusted: true;
  truncated: boolean;
}

export interface WebReaderClient {
  read(url: string, signal?: AbortSignal): Promise<WebReaderOutput>;
}

export interface JinaReaderClientOptions {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  now?: () => number;
}

const ENDPOINT = 'https://r.jina.ai/';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 71_680;
const MAX_TITLE_BYTES = 512;

const ERRORS = {
  configuration: 'Web Reader is not configured.',
  cancelled: 'Web Reader request was cancelled.',
  timeout: 'Web Reader timed out. Try again.',
  unavailable: 'Web Reader is unavailable. Try again later.',
  format: 'Web Reader returned an unsupported format.',
  tooLarge: 'Web Reader returned too much data.',
  invalid: 'Web Reader returned an invalid response.',
} as const;

type AbortSource = 'cancelled' | 'timeout';
type ClientErrorCategory = keyof typeof ERRORS;

class WebReaderClientError extends Error {
  constructor(readonly category: ClientErrorCategory) {
    super(ERRORS[category]);
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // Cleanup must not replace the fixed client error.
  }
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    cancelReader(reader);
    throw signal.reason;
  }

  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    cancelReader(reader);
    rejectAbort?.(signal.reason);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function readBoundedJson(
  response: Response,
  signal: AbortSignal,
  checkpoint: () => void,
): Promise<unknown> {
  if (!response.ok) {
    throw new WebReaderClientError(
      response.status === 401 || response.status === 403
        ? 'configuration'
        : 'unavailable',
    );
  }

  const contentType = response.headers.get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== 'application/json' && contentType !== 'text/json') {
    throw new WebReaderClientError('format');
  }
  if (!response.body) throw new WebReaderClientError('invalid');

  const reader = response.body.getReader();
  try {
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await readWithAbort(reader, signal);
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        cancelReader(reader);
        throw new WebReaderClientError('tooLarge');
      }
      chunks.push(value);
    }

    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }

    checkpoint();
    let decoded: string;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      checkpoint();
      throw new WebReaderClientError('invalid');
    }
    checkpoint();

    checkpoint();
    let payload: unknown;
    try {
      payload = JSON.parse(decoded) as unknown;
    } catch {
      checkpoint();
      throw new WebReaderClientError('invalid');
    }
    checkpoint();
    return payload;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Cleanup must not replace the fixed client error.
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let bytes = 0;
  let output = '';
  for (const codePoint of value) {
    const codePointBytes = Buffer.byteLength(codePoint, 'utf8');
    if (bytes + codePointBytes > maxBytes) break;
    output += codePoint;
    bytes += codePointBytes;
  }
  return output;
}

function normalizeEnvelope(payload: unknown, requestedUrl: string): WebReaderOutput {
  if (!isPlainObject(payload)
    || payload.code !== 200
    || payload.status !== 20000
    || !isPlainObject(payload.data)) {
    throw new WebReaderClientError('invalid');
  }
  const data = payload.data;
  if (typeof data.url !== 'string'
    || typeof data.content !== 'string'
    || (data.title !== undefined && typeof data.title !== 'string')) {
    throw new WebReaderClientError('invalid');
  }

  let sourceUrl: string;
  try {
    sourceUrl = parsePublicWebUrl(data.url).href;
  } catch (error) {
    if (error instanceof PublicWebUrlError) {
      throw new WebReaderClientError('invalid');
    }
    throw error;
  }

  const originalTitle = data.title;
  const trimmedTitle = originalTitle?.trim() ?? '';
  const title = truncateUtf8(trimmedTitle, MAX_TITLE_BYTES);
  return {
    requestedUrl,
    sourceUrl,
    title,
    markdown: data.content,
    contentIsUntrusted: true,
    truncated: originalTitle !== undefined
      && (trimmedTitle !== originalTitle || title !== trimmedTitle),
  };
}

function budgetOutput(output: WebReaderOutput): WebReaderOutput {
  if (Buffer.byteLength(JSON.stringify(output), 'utf8') <= MAX_OUTPUT_BYTES) {
    return output;
  }

  output.truncated = true;
  const codePoints = Array.from(output.markdown);
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    output.markdown = codePoints.slice(0, middle).join('');
    if (Buffer.byteLength(JSON.stringify(output), 'utf8') <= MAX_OUTPUT_BYTES) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  output.markdown = codePoints.slice(0, low).join('');
  return output;
}

export function createJinaReaderClient(
  options: JinaReaderClientOptions,
): WebReaderClient {
  const fetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const now = options.now ?? (() => performance.now());

  return {
    async read(url, signal) {
      const deadlineAt = now() + timeoutMs;
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      let providerAccessStarted = false;
      let abortSource: AbortSource | undefined = signal?.aborted
        ? 'cancelled'
        : undefined;
      const callerListenerAdded = Boolean(signal && !signal.aborted);
      const recordTimeout = () => { abortSource ??= 'timeout'; };
      const recordCancellation = () => { abortSource ??= 'cancelled'; };
      timeoutSignal.addEventListener('abort', recordTimeout, { once: true });
      if (signal && callerListenerAdded) {
        signal.addEventListener('abort', recordCancellation, { once: true });
      }

      const checkpoint = () => {
        if (now() >= deadlineAt) abortSource ??= 'timeout';
        if (abortSource) throw new WebReaderClientError(abortSource);
      };

      try {
        const apiKey = options.apiKey.trim();
        if (!apiKey || /[\r\n]/.test(apiKey)) {
          throw new WebReaderClientError('configuration');
        }
        checkpoint();

        const requestedUrl = parsePublicWebUrl(url).href;
        checkpoint();

        const requestSignal = signal
          ? AbortSignal.any([signal, timeoutSignal])
          : timeoutSignal;
        providerAccessStarted = true;
        const response = await fetch(ENDPOINT, {
          method: 'POST',
          redirect: 'error',
          signal: requestSignal,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            DNT: '1',
            'X-No-Cache': 'true',
            'X-Robots-Txt': 'true',
            'X-Respond-With': 'markdown',
            'X-Retain-Links': 'all',
            'X-Timeout': '25',
          },
          body: JSON.stringify({ url: requestedUrl }),
        });
        checkpoint();
        const payload = await readBoundedJson(response, requestSignal, checkpoint);

        checkpoint();
        let normalized: WebReaderOutput;
        try {
          normalized = normalizeEnvelope(payload, requestedUrl);
        } catch (error) {
          checkpoint();
          throw error;
        }
        checkpoint();

        checkpoint();
        const output = budgetOutput(normalized);
        checkpoint();
        checkpoint();
        return output;
      } catch (error) {
        if (!providerAccessStarted
          && (error instanceof PublicWebUrlError || error instanceof WebReaderClientError)) {
          throw error;
        }
        if (abortSource) throw new WebReaderClientError(abortSource);
        if (error instanceof PublicWebUrlError || error instanceof WebReaderClientError) throw error;
        checkpoint();
        throw new WebReaderClientError('unavailable');
      } finally {
        timeoutSignal.removeEventListener('abort', recordTimeout);
        if (signal && callerListenerAdded) {
          signal.removeEventListener('abort', recordCancellation);
        }
      }
    },
  };
}
