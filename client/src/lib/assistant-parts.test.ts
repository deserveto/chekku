import { describe, expect, it } from 'vitest';

import {
  appendTextDelta,
  groupAssistantParts,
  mergeAdjacentAssistantTurns,
  restoreAssistantParts,
  textFromAssistantParts,
  upsertToolPart,
} from './assistant-parts';
import type { AssistantPart } from './types';

function textPart(content: string, id = `text-${content}`): AssistantPart {
  return { type: 'text', id, content };
}

function toolPart(
  toolCallId: string,
  overrides: Partial<Extract<AssistantPart, { type: 'tool' }>> = {},
): AssistantPart {
  return {
    type: 'tool',
    id: `tool-${toolCallId}`,
    toolCallId,
    toolName: `tool_${toolCallId}`,
    status: 'running',
    ...overrides,
  };
}

describe('appendTextDelta', () => {
  it('merges consecutive text deltas into one logical text part', () => {
    let parts: AssistantPart[] = [];
    for (const delta of ['Hel', 'lo ', 'world']) {
      parts = appendTextDelta(parts, delta);
    }

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: 'text', content: 'Hello world' });
  });

  it('starts a new text part after a tool part instead of merging upward', () => {
    let parts: AssistantPart[] = [toolPart('a')];
    parts = appendTextDelta(parts, 'after');

    expect(parts).toHaveLength(2);
    expect(parts[0]?.type).toBe('tool');
    expect(parts[1]).toMatchObject({ type: 'text', content: 'after' });
  });

  it('ignores empty deltas', () => {
    const parts: AssistantPart[] = [textPart('hi')];
    expect(appendTextDelta(parts, '')).toBe(parts);
  });
});

describe('upsertToolPart', () => {
  it('appends a running tool part on first sight', () => {
    const parts = upsertToolPart([], {
      toolCallId: 'call-1',
      toolName: 'browser_goto',
      status: 'running',
      args: { url: 'https://example.com' },
    });

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      type: 'tool',
      toolCallId: 'call-1',
      toolName: 'browser_goto',
      status: 'running',
      args: { url: 'https://example.com' },
    });
  });

  it('updates the existing card on tool-result without duplicating it', () => {
    let parts = upsertToolPart([], {
      toolCallId: 'call-1',
      toolName: 'browser_goto',
      status: 'running',
      args: { url: 'https://example.com' },
    });
    parts = upsertToolPart(parts, {
      toolCallId: 'call-1',
      status: 'complete',
      result: { ok: true },
    });

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      status: 'complete',
      result: { ok: true },
      // args captured by tool-call must survive the result update
      args: { url: 'https://example.com' },
    });
  });

  it('updates the existing card on tool-error without duplicating it', () => {
    let parts = upsertToolPart([], {
      toolCallId: 'call-1',
      toolName: 'browser_click',
      status: 'running',
    });
    parts = upsertToolPart(parts, {
      toolCallId: 'call-1',
      status: 'error',
      result: 'navigation failed',
    });

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ status: 'error' });
  });
});

describe('chronological stream ordering', () => {
  it('case 1: tool-call, tool-result, text renders tool before text', () => {
    let parts: AssistantPart[] = [];
    parts = upsertToolPart(parts, {
      toolCallId: 'a',
      toolName: 'browser_goto',
      status: 'running',
    });
    parts = upsertToolPart(parts, { toolCallId: 'a', status: 'complete' });
    parts = appendTextDelta(parts, 'Loaded the page.');

    expect(parts.map((part) => part.type)).toEqual(['tool', 'text']);
  });

  it('case 2: text, tool-call, tool-result, text keeps text above and below the tool', () => {
    let parts: AssistantPart[] = [];
    parts = appendTextDelta(parts, 'I will inspect the page.');
    parts = upsertToolPart(parts, {
      toolCallId: 'a',
      toolName: 'browser_snapshot',
      status: 'running',
    });
    parts = upsertToolPart(parts, { toolCallId: 'a', status: 'complete' });
    parts = appendTextDelta(parts, 'Here is what I found.');

    expect(parts.map((part) => part.type)).toEqual([
      'text',
      'tool',
      'text',
    ]);
  });

  it('case 3: two interleaved tools stay at their execution points', () => {
    let parts: AssistantPart[] = [];
    parts = upsertToolPart(parts, {
      toolCallId: 'a',
      toolName: 'browser_goto',
      status: 'running',
    });
    parts = upsertToolPart(parts, { toolCallId: 'a', status: 'complete' });
    parts = appendTextDelta(parts, 'Middle text.');
    parts = upsertToolPart(parts, {
      toolCallId: 'b',
      toolName: 'browser_click',
      status: 'running',
    });
    parts = upsertToolPart(parts, { toolCallId: 'b', status: 'complete' });
    parts = appendTextDelta(parts, 'Final text.');

    expect(parts.map((part) => part.type)).toEqual([
      'tool',
      'text',
      'tool',
      'text',
    ]);
  });
});

describe('groupAssistantParts', () => {
  it('groups consecutive tool parts and keeps interleaved order', () => {
    const parts: AssistantPart[] = [
      toolPart('a'),
      toolPart('b'),
      textPart('between'),
      toolPart('c'),
      textPart('end'),
    ];

    const groups = groupAssistantParts(parts);

    expect(groups).toEqual([
      {
        kind: 'tools',
        parts: [toolPart('a'), toolPart('b')],
      },
      { kind: 'text', part: textPart('between') },
      { kind: 'tools', parts: [toolPart('c')] },
      { kind: 'text', part: textPart('end') },
    ]);
  });

  it('returns an empty list for empty parts', () => {
    expect(groupAssistantParts([])).toEqual([]);
  });
});

describe('restoreAssistantParts', () => {
  it('rebuilds the chronological timeline from Mastra Memory V2 parts', () => {
    const restored = restoreAssistantParts(
      {
        format: 2,
        parts: [
          { type: 'text', text: 'I will inspect the page.' },
          {
            type: 'tool-invocation',
            toolInvocation: {
              state: 'result',
              toolCallId: 'call-1',
              toolName: 'browser_goto',
              args: { url: 'https://example.com' },
              result: { ok: true },
            },
          },
          { type: 'text', text: 'The page is open.' },
          {
            type: 'tool-invocation',
            toolInvocation: {
              state: 'result',
              toolCallId: 'call-2',
              toolName: 'browser_snapshot',
              result: { fields: 4 },
            },
          },
          { type: 'text', text: 'Done.' },
        ],
      },
      'msg-1',
    );

    expect(restored).toBeDefined();
    expect(restored!.text).toBe(
      'I will inspect the page.\nThe page is open.\nDone.',
    );
    expect(
      restored!.parts.map((part) =>
        part.type === 'tool' ? part.toolName : 'text',
      ),
    ).toEqual([
      'text',
      'browser_goto',
      'text',
      'browser_snapshot',
      'text',
    ]);
    expect(restored!.parts[2]).toMatchObject({
      type: 'text',
      content: 'The page is open.',
    });
  });

  it('maps persisted invocation states onto card statuses', () => {
    const restored = restoreAssistantParts(
      {
        format: 2,
        parts: [
          {
            type: 'tool-invocation',
            toolInvocation: {
              state: 'result',
              toolCallId: 'a',
              toolName: 't1',
              result: { ok: 1 },
            },
          },
          {
            type: 'tool-invocation',
            toolInvocation: {
              state: 'call',
              toolCallId: 'b',
              toolName: 't2',
            },
          },
          {
            type: 'tool-invocation',
            toolInvocation: {
              state: 'result',
              toolCallId: 'c',
              toolName: 't3',
              errorText: 'selector not found',
            },
          },
          {
            type: 'tool-invocation',
            toolInvocation: {
              state: 'approval-requested',
              toolCallId: 'd',
              toolName: 't4',
            },
          },
          {
            type: 'tool-invocation',
            toolInvocation: {
              state: 'streams-once-then-crashed',
              toolCallId: 'e',
              toolName: 't5',
            },
          },
        ],
      },
      'msg-2',
    );

    expect(restored!.parts.map((part) => part.status)).toEqual([
      'complete',
      'interrupted',
      'error',
      'approval',
      'interrupted',
    ]);
    expect(restored!.parts[2]).toMatchObject({ result: 'selector not found' });
    expect(restored!.text).toBe('');
  });

  it('skips reasoning, step-start, and other non-timeline parts', () => {
    const restored = restoreAssistantParts(
      {
        format: 2,
        parts: [
          { type: 'step-start', model: 'test-model' },
          { type: 'reasoning', reasoning: 'hidden chain of thought' },
          { type: 'text', text: 'Visible.' },
          { type: 'source-url', url: 'https://example.com' },
        ],
      },
      'msg-3',
    );

    expect(restored!.parts).toHaveLength(1);
    expect(restored!.parts[0]).toMatchObject({
      type: 'text',
      content: 'Visible.',
    });
    expect(restored!.text).toBe('Visible.');
  });

  it('falls back to the convenience content string when no text parts exist', () => {
    const restored = restoreAssistantParts(
      {
        format: 2,
        parts: [
          {
            type: 'tool-invocation',
            toolInvocation: {
              state: 'result',
              toolCallId: 'a',
              toolName: 't1',
              result: {},
            },
          },
        ],
        content: 'Text stored only on the convenience field.',
      },
      'msg-4',
    );

    expect(restored!.text).toBe('Text stored only on the convenience field.');
    // The fallback must be visible in the timeline, not only copyable.
    expect(restored!.parts).toHaveLength(2);
    expect(restored!.parts[1]).toMatchObject({
      type: 'text',
      content: 'Text stored only on the convenience field.',
    });
  });

  it('ignores tool invocations without a usable toolCallId', () => {
    const restored = restoreAssistantParts(
      {
        format: 2,
        parts: [
          { type: 'tool-invocation', toolInvocation: { toolName: 't' } },
          { type: 'tool-invocation', toolInvocation: null },
          {
            type: 'tool-invocation',
            toolInvocation: { toolCallId: 'ok', toolName: 'fine' },
          },
        ],
      },
      'msg-5',
    );

    expect(restored!.parts).toHaveLength(1);
    expect(restored!.parts[0]).toMatchObject({ toolCallId: 'ok' });
  });

  it('returns undefined for non-V2 shapes so legacy text extraction applies', () => {
    expect(restoreAssistantParts('plain string', 'm')).toBeUndefined();
    expect(restoreAssistantParts(null, 'm')).toBeUndefined();
    expect(
      restoreAssistantParts({ text: 'v1-ish object' }, 'm'),
    ).toBeUndefined();
    expect(
      restoreAssistantParts({ format: 2, parts: 'not-an-array' }, 'm'),
    ).toBeUndefined();
  });
});

describe('textFromAssistantParts', () => {
  it('joins text parts and skips tool parts', () => {
    const parts: AssistantPart[] = [
      textPart('First block.'),
      toolPart('a'),
      textPart('Second block.'),
    ];
    expect(textFromAssistantParts(parts)).toBe(
      'First block.\nSecond block.',
    );
  });

  it('returns an empty string when no text parts exist', () => {
    expect(textFromAssistantParts([toolPart('a'), toolPart('b')])).toBe('');
    expect(textFromAssistantParts([])).toBe('');
  });
});

describe('mergeAdjacentAssistantTurns', () => {
  it('folds per-step assistant rows into one turn preserving part order', () => {
    const merged = mergeAdjacentAssistantTurns([
      {
        id: 'user-1',
        role: 'user',
        content: 'Check the page.',
        createdAt: 1,
      },
      {
        id: 'step-1',
        role: 'assistant',
        content: '',
        parts: [toolPart('a'), toolPart('b')],
        createdAt: 2,
      },
      {
        id: 'step-2',
        role: 'assistant',
        content: 'The page is open.',
        parts: [textPart('The page is open.')],
        createdAt: 3,
      },
      {
        id: 'step-3',
        role: 'assistant',
        content: 'All set.',
        parts: [textPart('All set.')],
        createdAt: 4,
      },
    ]);

    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ id: 'user-1', role: 'user' });
    expect(merged[1]).toMatchObject({
      id: 'step-1',
      role: 'assistant',
      content: 'The page is open.\nAll set.',
    });
    expect(
      merged[1]?.parts?.map((part) =>
        part.type === 'tool' ? part.toolCallId : 'text',
      ),
    ).toEqual(['a', 'b', 'text', 'text']);
  });

  it('starts a new turn after a user message', () => {
    const merged = mergeAdjacentAssistantTurns([
      { id: 'a1', role: 'assistant', content: 'first', createdAt: 1 },
      { id: 'u', role: 'user', content: 'again', createdAt: 2 },
      { id: 'a2', role: 'assistant', content: 'second', createdAt: 3 },
    ]);

    expect(merged.map((message) => message.id)).toEqual(['a1', 'u', 'a2']);
    expect(merged[0]?.content).toBe('first');
  });

  it('keeps single rows and merges without parts losslessly', () => {
    const single = [
      { id: 'a', role: 'assistant' as const, content: 'solo', createdAt: 1 },
    ];
    expect(mergeAdjacentAssistantTurns(single)).toEqual(single);

    const noParts = [
      { id: 'a', role: 'assistant' as const, content: 'one', createdAt: 1 },
      { id: 'b', role: 'assistant' as const, content: 'two', createdAt: 2 },
    ];
    const merged = mergeAdjacentAssistantTurns(noParts);
    expect(merged).toEqual([
      { id: 'a', role: 'assistant', content: 'one\ntwo', createdAt: 1 },
    ]);
  });
});
