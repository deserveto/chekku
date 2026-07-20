import type { InputProcessor } from '@mastra/core/processors';
import { Memory } from '@mastra/memory';
import { TokenLimiterProcessor } from '@mastra/core/processors';

import { env } from '../../config/env.js';
import { stripOpenAICompatibleRouterId } from '../gateways/openai-compatible-model.js';

export const AGENT_MEMORY_LAST_MESSAGES = 50;

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'hy3-preview': 192_000,
  'qwen3.6-35b-a3b-fast': 262_144,
  'qwen3.6-35b-a3b': 262_144,
};

const FALLBACK_CONTEXT_WINDOW = 192_000;
const CONTEXT_RESERVE_TOKENS = 60_000;

export const CHAR_GUARD_CHARS_PER_TOKEN = 2.5;
export const CHAR_GUARD_OUTPUT_RESERVE_TOKENS = 32_000;

export function getModelContextWindow(modelId: string): number {
  if (!modelId || !modelId.trim()) return FALLBACK_CONTEXT_WINDOW;
  const native = stripOpenAICompatibleRouterId(modelId);
  return MODEL_CONTEXT_WINDOWS[native] ?? FALLBACK_CONTEXT_WINDOW;
}

export function getModelMessageBudget(modelId: string): number {
  return Math.max(0, getModelContextWindow(modelId) - CONTEXT_RESERVE_TOKENS);
}

export function getCharBudget(modelId: string): number {
  return Math.max(
    0,
    Math.floor(
      (getModelContextWindow(modelId) - CHAR_GUARD_OUTPUT_RESERVE_TOKENS) * CHAR_GUARD_CHARS_PER_TOKEN,
    ),
  );
}

export function createAgentMemory(): Memory {
  return new Memory({ options: { lastMessages: AGENT_MEMORY_LAST_MESSAGES } });
}

export function createAgentContextLimiter(): TokenLimiterProcessor {
  return new TokenLimiterProcessor({
    limit: getModelMessageBudget(env.LLM_DEFAULT_MODEL),
  });
}

export type CharBudgetPart = {
  type: string;
  text?: string;
  data?: string | Uint8Array;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  output?: { type: string; value?: unknown };
  mediaType?: string;
  [key: string]: unknown;
};
export type CharBudgetMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | CharBudgetPart[];
};
export type CharBudgetPrompt = CharBudgetMessage[];

function dataChars(data: unknown): number {
  if (typeof data === 'string') return data.length;
  if (data instanceof Uint8Array) return data.byteLength;
  return 0;
}

function outputChars(output: { type: string; value?: unknown } | undefined): number {
  if (!output || typeof output !== 'object') return 0;
  const t = output.type;
  const v = output.value;
  if ((t === 'text' || t === 'error-text') && typeof v === 'string') return v.length;
  if (t === 'json' || t === 'error-json') return v == null ? 0 : JSON.stringify(v).length;
  if (t === 'content' && Array.isArray(v)) {
    let n = 0;
    for (const item of v as Array<{ type?: string; text?: string; data?: string | Uint8Array }>) {
      if (!item) continue;
      if (typeof item.text === 'string') n += item.text.length;
      n += dataChars(item.data);
    }
    return n;
  }
  return 0;
}

function partChars(part: CharBudgetPart): number {
  switch (part.type) {
    case 'text':
    case 'reasoning':
      return typeof part.text === 'string' ? part.text.length : 0;
    case 'file':
      return dataChars(part.data);
    case 'media':
      return dataChars(part.data);
    case 'tool-call':
      return (part.toolName ? String(part.toolName).length : 0) + (part.input == null ? 0 : JSON.stringify(part.input).length);
    case 'tool-result':
      return outputChars(part.output as { type: string; value?: unknown } | undefined);
    default:
      return 0;
  }
}

export function messageChars(message: CharBudgetMessage): number {
  if (!message) return 0;
  if (typeof message.content === 'string') return message.content.length;
  if (Array.isArray(message.content)) {
    return message.content.reduce((n, p) => n + partChars(p as CharBudgetPart), 0);
  }
  return 0;
}

export function totalPromptChars(prompt: CharBudgetPrompt): number {
  return prompt.reduce((n, m) => n + messageChars(m as CharBudgetMessage), 0);
}

type PromptItem = { kind: 'system' | 'group'; msgs: CharBudgetMessage[] };

function partitionItems(prompt: CharBudgetPrompt): PromptItem[] {
  const items: PromptItem[] = [];
  for (const message of prompt) {
    const role = message.role;
    if (role === 'system') {
      items.push({ kind: 'system', msgs: [message] });
      continue;
    }
    if (role === 'tool') {
      const last = items[items.length - 1];
      if (last && last.kind === 'group') last.msgs.push(message);
      else items.push({ kind: 'group', msgs: [message] });
    } else {
      items.push({ kind: 'group', msgs: [message] });
    }
  }
  return items;
}

const TRUNCATION_MARKER = '…[truncated to fit model context budget]';

type StringHandle = { len: number; get(): string; set(value: string): void };

const PROTOCOL_FIELDS = new Set(['role', 'type', 'toolCallId', 'toolName', 'id', 'name']);

function collectStringHandles(root: unknown, out: StringHandle[]): void {
  if (root == null || typeof root !== 'object') return;
  if (typeof root === 'string') return;
  if (root instanceof Uint8Array) return;
  if (Array.isArray(root)) {
    for (let i = 0; i < root.length; i++) {
      const current = root[i];
      if (typeof current === 'string') {
        const index = i;
        const owner = root;
        out.push({
          len: current.length,
          get: () => owner[index],
          set: (value: string) => {
            owner[index] = value;
          },
        });
      } else {
        collectStringHandles(current, out);
      }
    }
    return;
  }
  for (const key of Object.keys(root as Record<string, unknown>)) {
    const value = (root as Record<string, unknown>)[key];
    if (typeof value === 'string') {
      if (PROTOCOL_FIELDS.has(key)) continue;
      const owner = root as Record<string, unknown>;
      out.push({
        len: value.length,
        get: () => owner[key] as string,
        set: (v: string) => {
          owner[key] = v;
        },
      });
    } else {
      collectStringHandles(value, out);
    }
  }
}

function truncatePromptMessages(messages: CharBudgetMessage[], budget: number): CharBudgetMessage[] {
  const clone: CharBudgetMessage[] = structuredClone(messages);
  const handles: StringHandle[] = [];
  for (const message of clone) collectStringHandles(message, handles);
  for (let iteration = 0; iteration < 200; iteration++) {
    const total = handles.reduce((n, h) => n + h.len, 0);
    if (total <= budget) break;
    handles.sort((a, b) => b.len - a.len);
    const longest = handles[0];
    if (!longest || longest.len <= TRUNCATION_MARKER.length + 1) break;
    const next = Math.max(0, Math.floor(longest.len / 2));
    longest.set(longest.get().slice(0, next) + TRUNCATION_MARKER);
    longest.len = next + TRUNCATION_MARKER.length;
  }
  return clone;
}

export function prunePromptToCharBudget(prompt: CharBudgetPrompt, budget: number): CharBudgetPrompt {
  if (budget <= 0) return prompt;
  if (totalPromptChars(prompt) <= budget) return prompt;

  const items = partitionItems(prompt);
  const itemChars = items.map((item) => item.msgs.reduce((n, m) => n + messageChars(m), 0));
  const keep = new Array<boolean>(items.length).fill(true);

  const groupIndexes: number[] = [];
  for (let i = 0; i < items.length; i++) if (items[i]?.kind === 'group') groupIndexes.push(i);

  let running = itemChars.reduce((a, b) => a + b, 0);
  for (let k = 0; k < groupIndexes.length - 1 && running > budget; k++) {
    const i = groupIndexes[k] as number;
    keep[i] = false;
    running -= itemChars[i] as number;
  }

  const survivors: CharBudgetMessage[] = [];
  for (let i = 0; i < items.length; i++) {
    if (keep[i]) survivors.push(...(items[i] as PromptItem).msgs);
  }

  if (totalPromptChars(survivors) > budget) {
    return truncatePromptMessages(survivors, budget);
  }
  return survivors;
}

/**
 * Estimator-independent backstop that caps the final assembled prompt in
 * characters. The tokenx-based TokenLimiterProcessor under-counts dense tool
 * output (notably base64 screenshots), so heavy multi-step turns can exceed the
 * real model window even when the estimate says they fit. This guard runs last,
 * drops oldest non-system turns (keeping each assistant tool-call with its
 * tool-result so the provider never sees an orphan), and truncates any single
 * message that still exceeds the budget.
 */
export function createCharBudgetGuard(): InputProcessor {
  const budget = getCharBudget(env.LLM_DEFAULT_MODEL);
  const processor: InputProcessor = {
    id: 'char-budget-guard',
    processLLMRequest: ({ prompt }) => {
      if (budget <= 0) return;
      const candidate = prunePromptToCharBudget(prompt as unknown as CharBudgetPrompt, budget);
      if (candidate === (prompt as unknown as CharBudgetPrompt)) return;
      type PromptShape = typeof prompt;
      return { prompt: candidate as unknown as PromptShape };
    },
  };
  return processor;
}
