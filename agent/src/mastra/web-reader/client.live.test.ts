import { describe, expect, it } from 'vitest';

import { createJinaReaderClient } from './client.js';
import { parsePublicWebUrl } from './url.js';

const live = process.env.npm_lifecycle_event === 'test:web-reader:live';

describe.skipIf(!live)('Jina Reader live smoke test', () => {
  it('reads one public page into bounded untrusted output', async () => {
    const apiKey = process.env.WEB_READER_API_KEY?.trim();
    if (!apiKey) throw new Error('WEB_READER_API_KEY is required for live Web Reader tests.');

    const output = await createJinaReaderClient({ apiKey }).read('https://example.com/');

    expect({
      requestedUrl: output.requestedUrl === 'https://example.com/',
      publicSource: (() => {
        try { parsePublicWebUrl(output.sourceUrl); return true; }
        catch { return false; }
      })(),
      titleBounded: Buffer.byteLength(output.title, 'utf8') <= 512,
      hasMarkdown: output.markdown.length > 0,
      contentIsUntrusted: output.contentIsUntrusted,
      bounded: Buffer.byteLength(JSON.stringify(output), 'utf8') <= 71_680,
    }).toEqual({
      requestedUrl: true,
      publicSource: true,
      titleBounded: true,
      hasMarkdown: true,
      contentIsUntrusted: true,
      bounded: true,
    });
  });
});
