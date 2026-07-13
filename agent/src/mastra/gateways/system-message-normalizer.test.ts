import { describe, expect, it } from 'vitest';

import { normalizeSystemMessages } from './system-message-normalizer.js';

describe('normalizeSystemMessages', () => {
  it('keeps an existing leading system message unchanged', () => {
    const prompt = [
      {
        role: 'system',
        content: 'You are a helpful assistant.',
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }],
      },
    ];

    expect(normalizeSystemMessages(prompt)).toEqual(prompt);
  });

  it('moves a late system message to the beginning', () => {
    const result = normalizeSystemMessages([
      {
        role: 'user',
        content: [{ type: 'text', text: 'Open example.com' }],
      },
      {
        role: 'system',
        content: 'Current browser context: no active page.',
      },
    ]);

    expect(result).toEqual([
      {
        role: 'system',
        content: 'Current browser context: no active page.',
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Open example.com' }],
      },
    ]);
  });

  it('merges multiple system messages at the beginning', () => {
    const result = normalizeSystemMessages([
      {
        role: 'system',
        content: 'You are QA Web Agent.',
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Open example.com' }],
      },
      {
        role: 'system',
        content: 'Browser context: page is empty.',
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Working on it.' }],
      },
    ]);

    expect(result).toEqual([
      {
        role: 'system',
        content:
          'You are QA Web Agent.\n\nBrowser context: page is empty.',
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Open example.com' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Working on it.' }],
      },
    ]);
  });

  it('preserves tool and assistant message ordering', () => {
    const result = normalizeSystemMessages([
      {
        role: 'user',
        content: [{ type: 'text', text: 'Use the browser.' }],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'browser_open',
            input: { url: 'https://example.com' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'browser_open',
            output: {
              type: 'text',
              value: 'Opened example.com',
            },
          },
        ],
      },
      {
        role: 'system',
        content: 'Browser page title: Example Domain.',
      },
    ]);

    expect(result.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
    ]);
  });
});
