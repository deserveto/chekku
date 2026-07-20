import { Memory } from '@mastra/memory';
import { TokenLimiterProcessor } from '@mastra/core/processors';
import { describe, expect, it } from 'vitest';

import {
  AGENT_MEMORY_LAST_MESSAGES,
  CHAR_GUARD_CHARS_PER_TOKEN,
  CHAR_GUARD_OUTPUT_RESERVE_TOKENS,
  createAgentContextLimiter,
  createAgentMemory,
  createCharBudgetGuard,
  getCharBudget,
  getModelContextWindow,
  getModelMessageBudget,
  prunePromptToCharBudget,
  type CharBudgetPrompt,
} from './context-limit.js';

type AnyMsg = CharBudgetPrompt[number];
function sys(text: string): AnyMsg {
  return { role: 'system', content: text };
}
function user(text: string): AnyMsg {
  return { role: 'user', content: [{ type: 'text', text }] };
}
function assistantText(text: string): AnyMsg {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}
function assistantToolCall(id: string, toolName: string, input: unknown): AnyMsg {
  return {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: id, toolName, input }],
  };
}
function toolText(id: string, toolName: string, value: string): AnyMsg {
  return {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: id, toolName, output: { type: 'text', value } }],
  };
}
function toolMedia(id: string, toolName: string, base64: string): AnyMsg {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: id,
        toolName,
        output: { type: 'content', value: [{ type: 'media', data: base64, mediaType: 'image/jpeg' }] },
      },
    ],
  };
}

describe('agent context limiting (model-adaptive)', () => {
  it('returns the known window for each configured model', () => {
    expect(getModelContextWindow('hy3-preview')).toBe(192_000);
    expect(getModelContextWindow('qwen3.6-35b-a3b-fast')).toBe(262_144);
    expect(getModelContextWindow('qwen3.6-35b-a3b')).toBe(262_144);
  });

  it('strips the gateway router prefix before looking up the window', () => {
    expect(
      getModelContextWindow('openai-compatible/gateway/hy3-preview'),
    ).toBe(192_000);
  });

  it('falls back to a conservative window for unknown or empty model ids', () => {
    expect(getModelContextWindow('some-unknown-model')).toBe(192_000);
    expect(getModelContextWindow('')).toBe(192_000);
  });

  it('reserves room for system, tools, and output when computing the message budget', () => {
    expect(getModelMessageBudget('hy3-preview')).toBeLessThan(192_000);
    expect(getModelMessageBudget('hy3-preview')).toBeGreaterThan(0);
    expect(
      getModelMessageBudget('qwen3.6-35b-a3b-fast'),
    ).toBeGreaterThan(getModelMessageBudget('hy3-preview'));
  });

  it('wires a TokenLimiterProcessor sized to the configured model', () => {
    expect(createAgentContextLimiter()).toBeInstanceOf(TokenLimiterProcessor);
  });

  it('returns a fresh Memory instance per call so agents never share memory state', () => {
    const a = createAgentMemory();
    const b = createAgentMemory();
    expect(a).toBeInstanceOf(Memory);
    expect(a).not.toBe(b);
  });

  it('bounds recalled message history to a finite positive window', () => {
    expect(Number.isFinite(AGENT_MEMORY_LAST_MESSAGES)).toBe(true);
    expect(AGENT_MEMORY_LAST_MESSAGES).toBeGreaterThan(0);
    expect(AGENT_MEMORY_LAST_MESSAGES).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });
});

describe('char-budget guard (estimator-independent backstop)', () => {
  it('derives a conservative char budget from each model window', () => {
    expect(getCharBudget('hy3-preview')).toBe(
      Math.floor((192_000 - CHAR_GUARD_OUTPUT_RESERVE_TOKENS) * CHAR_GUARD_CHARS_PER_TOKEN),
    );
    expect(getCharBudget('qwen3.6-35b-a3b-fast')).toBeGreaterThan(getCharBudget('hy3-preview'));
  });

  it('falls back to the conservative window for unknown or empty model ids', () => {
    expect(getCharBudget('')).toBe(getCharBudget('hy3-preview'));
    expect(getCharBudget('openai-compatible/gateway/hy3-preview')).toBe(getCharBudget('hy3-preview'));
  });

  it('leaves a prompt unchanged when it already fits the char budget', () => {
    const budget = 100_000;
    const prompt: CharBudgetPrompt = [sys('system'), user('hello')];
    const result = prunePromptToCharBudget(prompt, budget);
    expect(result).toBe(prompt);
  });

  it('drops oldest non-system groups until the prompt fits, preserving system + most recent', () => {
    const budget = 40;
    const prompt: CharBudgetPrompt = [
      sys('system'),
      user('old task one'), // group 1 (oldest)
      assistantText('old answer one'),
      user('old task two'), // group 2
      assistantText('old answer two'),
      user('latest task'), // group 3 (newest)
    ];
    const result = prunePromptToCharBudget(prompt, budget);

    expect(result).not.toBe(prompt);
    expect(result.length).toBeLessThan(prompt.length);
    expect(result[0]).toEqual(sys('system'));
    expect(result[result.length - 1]).toEqual(user('latest task'));
    const totalChars = result.reduce((n, m) => n + messageChars(m), 0);
    expect(totalChars).toBeLessThanOrEqual(budget);
  });

  it('keeps each assistant tool-call together with its tool-result so the provider never sees an orphan', () => {
    const big = 'x'.repeat(500);
    const budget = 560;
    const prompt: CharBudgetPrompt = [
      sys('system'),
      user('do thing'),
      assistantToolCall('call-1', 'inspect', { q: 1 }),
      toolText('call-1', 'inspect', big),
      user('do other thing'),
      assistantToolCall('call-2', 'inspect', { q: 2 }),
      toolText('call-2', 'inspect', big),
    ];
    const result = prunePromptToCharBudget(prompt, budget);

    const toolCallIds = new Set<string>();
    const resultToolCallIds = new Set<string>();
    for (const m of result) {
      if (m.role === 'tool') {
        for (const p of m.content as Array<{ type: string; toolCallId?: string }>) {
          if (p.type === 'tool-result' && p.toolCallId) toolCallIds.add(p.toolCallId);
        }
      }
      if (m.role === 'assistant') {
        for (const p of m.content as Array<{ type: string; toolCallId?: string }>) {
          if (p.type === 'tool-call' && p.toolCallId) resultToolCallIds.add(p.toolCallId);
        }
      }
    }
    for (const id of toolCallIds) {
      expect(resultToolCallIds.has(id)).toBe(true);
    }
    expect(result.length).toBeLessThan(prompt.length);
  });

  it('counts base64 image data and tool-result text as prompt characters', () => {
    const base64 = 'a'.repeat(1_000);
    const text = 't'.repeat(200);
    const prompt: CharBudgetPrompt = [
      sys('s'),
      assistantToolCall('c1', 'inspect', {}),
      toolMedia('c1', 'inspect', base64),
      assistantToolCall('c2', 'inspect', {}),
      toolText('c2', 'inspect', text),
    ];
    const total = prompt.reduce((n, m) => n + messageChars(m), 0);
    const expectedTotal =
      's'.length + // sys('s')
      'inspect'.length + JSON.stringify({}).length + // assistantToolCall c1 (toolName + JSON input)
      base64.length + // media data
      'inspect'.length + JSON.stringify({}).length + // assistantToolCall c2
      text.length; // tool-result text
    expect(total).toBe(expectedTotal);
  });

  it('truncates a single oversized message rather than emitting a prompt that still exceeds the budget', () => {
    const huge = 'h'.repeat(50_000);
    const budget = 5_000;
    const prompt: CharBudgetPrompt = [sys('system'), user(huge)];
    const result = prunePromptToCharBudget(prompt, budget);

    expect(result).not.toBe(prompt);
    const totalChars = result.reduce((n, m) => n + messageChars(m), 0);
    expect(totalChars).toBeLessThanOrEqual(budget);
    expect(result.some((m) => JSON.stringify(m).includes('h'.repeat(10)))).toBe(true);
  });

  it('processLLMRequest returns undefined when under budget and a pruned prompt when over', () => {
    const guard = createCharBudgetGuard() as unknown as {
      id: string;
      processLLMRequest: (args: { prompt: CharBudgetPrompt }) => { prompt: CharBudgetPrompt } | undefined;
    };
    expect(typeof guard.id).toBe('string');
    expect(typeof guard.processLLMRequest).toBe('function');

    const small: CharBudgetPrompt = [sys('s'), user('hi')];
    expect(guard.processLLMRequest({ prompt: small })).toBeUndefined();

    const budget = getCharBudget(process.env.LLM_DEFAULT_MODEL ?? '');
    const over: CharBudgetPrompt = [
      sys('s'),
      user('x'.repeat(budget)),
      user('latest'),
    ];
    const out = guard.processLLMRequest({ prompt: over });
    expect(out).toBeDefined();
    const result = out?.prompt ?? [];
    const totalChars = result.reduce((n, m) => n + messageChars(m), 0);
    expect(totalChars).toBeLessThanOrEqual(budget);
    expect(result.at(-1)).toEqual(user('latest'));
  });

  it('protects protocol fields like toolCallId from truncation even when they are among the longest strings', () => {
    const longId = 'call_'.padEnd(100, 'x'); // 100 chars, past the 41-char stop threshold
    const hugeText = 'h'.repeat(500);
    const prompt: CharBudgetPrompt = [
      sys('s'),
      {
        role: 'assistant',
        content: [
          { type: 'text', text: hugeText },
          { type: 'tool-call', toolCallId: longId, toolName: 'inspect', input: {} },
        ],
      },
    ];
    const result = prunePromptToCharBudget(prompt, 100);

    const parts = result[1].content as Array<{ type: string; toolCallId?: string; text?: string }>;
    const toolCallPart = parts.find((p) => p.type === 'tool-call');
    const textPart = parts.find((p) => p.type === 'text');
    expect(toolCallPart?.toolCallId).toBe(longId);
    expect(textPart?.text?.length).toBeLessThan(hugeText.length);
  });
});

function messageChars(m: AnyMsg): number {
  if (typeof m.content === 'string') return m.content.length;
  if (Array.isArray(m.content)) {
    return m.content.reduce((n, p) => {
      const part = p as { type: string; text?: string; toolName?: string; input?: unknown; output?: { type: string; value?: unknown }; data?: unknown };
      if ((part.type === 'text' || part.type === 'reasoning') && typeof part.text === 'string') return n + part.text.length;
      if (part.type === 'media' && typeof part.data === 'string') return n + part.data.length;
      if (part.type === 'tool-call') return n + (part.toolName ? String(part.toolName).length : 0) + (part.input == null ? 0 : JSON.stringify(part.input).length);
      if (part.type === 'tool-result' && part.output) {
        const out = part.output as { type: string; value?: unknown };
        if ((out.type === 'text' || out.type === 'error-text') && typeof out.value === 'string') return n + out.value.length;
        if (out.type === 'json' || out.type === 'error-json') return n + (out.value == null ? 0 : JSON.stringify(out.value).length);
        if (out.type === 'content' && Array.isArray(out.value)) return n + (out.value as Array<{ type: string; text?: string; data?: string }>).reduce((m2, v) => m2 + (typeof v.text === 'string' ? v.text.length : 0) + (typeof v.data === 'string' ? v.data.length : 0), 0);
      }
      return n;
    }, 0);
  }
  return 0;
}
