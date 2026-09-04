import { Memory } from '@mastra/memory';
import { TokenLimiterProcessor } from '@mastra/core/processors';
import { describe, expect, it } from 'vitest';

import {
  AGENT_MEMORY_LAST_MESSAGES,
  CHAR_GUARD_CHARS_PER_TOKEN,
  CHAR_GUARD_OUTPUT_RESERVE_TOKENS,
  VISION_PART_ESTIMATE_CHARS,
  VISION_PART_ESTIMATE_TOKENS,
  createAgentContextLimiter,
  createAgentMemory,
  createCharBudgetGuard,
  getCharBudget,
  getModelContextWindow,
  getModelMessageBudget,
  TITLE_GENERATION_INSTRUCTIONS,
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
function userImage(base64: string, mediaType = 'image/png'): AnyMsg {
  return {
    role: 'user',
    content: [
      { type: 'text', text: 'analyze this' },
      { type: 'file', data: base64, mediaType, filename: 'upload.png' },
    ],
  };
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

  it('leaves thread title generation off by default', () => {
    const memory = createAgentMemory();
    expect(memory.getMergedThreadConfig().generateTitle).toBe(false);
  });

  it('opts into Mastra thread title generation when requested', () => {
    const memory = createAgentMemory({ generateTitle: true });
    const config = memory.getMergedThreadConfig().generateTitle;
    expect(config === true || (typeof config === 'object' && config !== null)).toBe(true);
  });

  it('forwards the object form with strict instructions verbatim', () => {
    const memory = createAgentMemory({
      generateTitle: { instructions: TITLE_GENERATION_INSTRUCTIONS },
    });
    const config = memory.getMergedThreadConfig().generateTitle;
    expect(typeof config).toBe('object');
    expect((config as { instructions?: string }).instructions).toBe(
      TITLE_GENERATION_INSTRUCTIONS,
    );
  });

  it('bounds recalled message history to a finite positive window', () => {
    expect(Number.isFinite(AGENT_MEMORY_LAST_MESSAGES)).toBe(true);
    expect(AGENT_MEMORY_LAST_MESSAGES).toBeGreaterThan(0);
    expect(AGENT_MEMORY_LAST_MESSAGES).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });
});

describe('vision-aware token limiting', () => {
  type CountableMessage = { role?: string; content?: unknown };

  function counterOf(limiter: TokenLimiterProcessor): (message: CountableMessage) => Promise<number> {
    const method = (limiter as unknown as {
      countInputMessageTokens: (message: CountableMessage) => Promise<number>;
    }).countInputMessageTokens;
    return (message) => method.call(limiter, message);
  }

  function dbUserMessage(parts: unknown[]): CountableMessage & { id: string; createdAt?: number } {
    return { id: 'msg-1', role: 'user', createdAt: 1, content: { format: 2, parts } };
  }

  it('counts image file parts at the fixed vision estimate instead of base64 length', async () => {
    const limiter = createAgentContextLimiter();
    const base64 = 'a'.repeat(132_000);
    const estimate = await counterOf(limiter)(
      dbUserMessage([
        { type: 'text', text: 'What is this document about? Summarize each page' },
        ...Array.from({ length: 8 }, () => ({
          type: 'file',
          mimeType: 'image/jpeg',
          data: `data:image/jpeg;base64,${base64}`,
        })),
      ]),
    );

    // The stock estimator would count ~206k tokens for this payload and trip
    // the limiter; the vision-aware counter must land inside the model budget.
    expect(estimate).toBeLessThan(getModelMessageBudget('qwen3.6-35b-a3b-fast'));
    expect(estimate).toBeGreaterThanOrEqual(8 * VISION_PART_ESTIMATE_TOKENS);
  });

  it('matches the stock limiter for messages without image parts', async () => {
    const visionAware = createAgentContextLimiter();
    const stock = new TokenLimiterProcessor({ limit: 10_000 });
    const message = dbUserMessage([
      { type: 'text', text: 'Summarize this document.' },
      { type: 'file', mimeType: 'application/pdf', data: 'x'.repeat(2_000) },
    ]);

    await expect(counterOf(visionAware)(message)).resolves.toBe(
      await counterOf(stock)(message),
    );
  });

  it('does not trip the input-step tripwire for a multi-page upload', async () => {
    const limiter = createAgentContextLimiter();
    const base64 = 'a'.repeat(132_000);
    const messages = [
      dbUserMessage([{ type: 'text', text: 'earlier turn' }]),
      dbUserMessage([
        { type: 'text', text: 'What is this document about? Summarize each page' },
        ...Array.from({ length: 8 }, () => ({
          type: 'file',
          mimeType: 'image/png',
          data: `data:image/png;base64,${base64}`,
        })),
      ]),
    ];
    const removed: string[] = [];
    const messageList = {
      get: { all: { db: () => messages } },
      getAllSystemMessages: () => [],
      removeByIds: (ids: string[]) => removed.push(...ids),
    };

    await expect(
      limiter.processInputStep({
        messageList,
      } as unknown as Parameters<TokenLimiterProcessor['processInputStep']>[0]),
    ).resolves.toBeUndefined();
    expect(removed).toEqual([]);
  });

  it('derives the token estimate from the char-guard constants', () => {
    expect(VISION_PART_ESTIMATE_TOKENS).toBe(
      Math.round(VISION_PART_ESTIMATE_CHARS / CHAR_GUARD_CHARS_PER_TOKEN),
    );
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

  it('counts user-message image file parts at the fixed vision estimate, not base64 length', () => {
    const base64 = 'a'.repeat(600_000); // would exhaust the whole budget if counted raw
    const prompt: CharBudgetPrompt = [sys('s'), userImage(base64, 'image/jpeg')];
    const total = prompt.reduce((n, m) => n + messageChars(m), 0);
    expect(total).toBe('s'.length + 'analyze this'.length + VISION_PART_ESTIMATE_CHARS);
  });

  it('still counts non-image file parts at raw data length', () => {
    const data = 'a'.repeat(2_000);
    const prompt: CharBudgetPrompt = [userImage(data, 'application/pdf')];
    const total = prompt.reduce((n, m) => n + messageChars(m), 0);
    expect(total).toBe('analyze this'.length + data.length);
  });

  it('fits a 20-page PDF-style message without pruning', () => {
    const budget = getCharBudget('qwen3.6-35b-a3b-fast');
    const prompt: CharBudgetPrompt = [
      sys('system'),
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Summarize the attached report.' },
          ...Array.from({ length: 20 }, (_, i) => ({
            type: 'file',
            data: 'p'.repeat(300_000),
            mediaType: 'image/jpeg',
            filename: `report-p${i + 1}.jpg`,
          })),
        ],
      },
    ];
    const result = prunePromptToCharBudget(prompt, budget);
    expect(result).toBe(prompt);
  });

  it('drops binary parts whole instead of slicing them when they block the budget', () => {
    const imageData = 'i'.repeat(4_100); // longer than the estimate so it would top the sort
    const hugeText = 'h'.repeat(500);
    const prompt: CharBudgetPrompt = [
      sys('s'),
      {
        role: 'user',
        content: [
          { type: 'text', text: hugeText },
          { type: 'file', data: imageData, mediaType: 'image/png', filename: 'shot.png' },
        ],
      },
    ];
    const result = prunePromptToCharBudget(prompt, 100);

    const parts = (result[1] ?? result[0]).content as Array<{ type: string; text?: string; data?: string }>;
    const filePart = parts.find((p) => p.type === 'file');
    // The 4,000-char vision estimate can never fit a 100-char budget, so the
    // part is dropped WHOLE — its payload is never sliced into garbage.
    expect(filePart).toBeUndefined();
    const textPart = parts.find((p) => p.type === 'text');
    expect(textPart?.text?.length).toBeLessThan(hugeText.length);
    const totalChars = result.reduce((n, m) => n + messageChars(m), 0);
    expect(totalChars).toBeLessThanOrEqual(100);
  });

  it('enforces the budget when binary payloads dominate the surviving newest turn', () => {
    const budget = 10_000;
    const prompt: CharBudgetPrompt = [
      sys('s'),
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at these' },
          ...Array.from({ length: 10 }, () => ({
            type: 'file',
            data: 'x'.repeat(10),
            mediaType: 'image/png',
            filename: 'p.png',
          })),
        ],
      },
    ];
    // 10 image parts at the fixed 4,000-char vision estimate far exceed the
    // budget, and the single group cannot be dropped (it is the newest).
    const result = prunePromptToCharBudget(prompt, budget);

    const total = result.reduce((n, m) => n + messageChars(m), 0);
    expect(total).toBeLessThanOrEqual(budget);
    const content = result[result.length - 1].content as Array<{ type: string; data?: string }>;
    const fileParts = content.filter((p) => p.type === 'file');
    // Surviving parts are intact (never sliced); the rest were dropped whole.
    expect(fileParts.length).toBe(2);
    for (const part of fileParts) {
      expect(part.data).toBe('x'.repeat(10));
    }
  });

  it('drops binary items nested in tool-result output without orphaning the tool call', () => {
    const budget = 5_000;
    const prompt: CharBudgetPrompt = [
      sys('s'),
      assistantToolCall('c1', 'screenshot', {}),
      toolMedia('c1', 'screenshot', 'm'.repeat(50_000)),
    ];
    const result = prunePromptToCharBudget(prompt, budget);

    const total = result.reduce((n, m) => n + messageChars(m), 0);
    expect(total).toBeLessThanOrEqual(budget);

    const toolMessage = result.find((m) => m.role === 'tool');
    expect(toolMessage).toBeDefined();
    const toolResult = (toolMessage?.content as Array<{ type: string; toolCallId?: string; output?: { type: string; value?: unknown } }>)[0];
    expect(toolResult?.toolCallId).toBe('c1');
    // The tool-result itself survives (its tool-call pairing stays intact);
    // only the oversized binary item inside its output was dropped.
    expect(toolResult?.output?.type).toBe('content');
    const assistantMessage = result.find((m) => m.role === 'assistant');
    const toolCall = (assistantMessage?.content as Array<{ type: string; toolCallId?: string }>)[0];
    expect(toolCall?.toolCallId).toBe('c1');
  });
});

function messageChars(m: AnyMsg): number {
  if (typeof m.content === 'string') return m.content.length;
  if (Array.isArray(m.content)) {
    return m.content.reduce((n, p) => {
      const part = p as { type: string; text?: string; toolName?: string; input?: unknown; output?: { type: string; value?: unknown }; data?: unknown; mediaType?: unknown };
      if ((part.type === 'text' || part.type === 'reasoning') && typeof part.text === 'string') return n + part.text.length;
      if (part.type === 'file' && typeof part.mediaType === 'string' && part.mediaType.startsWith('image/')) return n + VISION_PART_ESTIMATE_CHARS;
      if (part.type === 'file') return n + (typeof part.data === 'string' ? part.data.length : part.data instanceof Uint8Array ? part.data.byteLength : 0);
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
