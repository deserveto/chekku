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

/**
 * Vision-encoder inputs cost a bounded number of tokens per image regardless of
 * base64 length, so user-message image file parts count as a fixed estimate
 * instead of raw base64 chars (which would exhaust the whole budget and force
 * the truncation loop to slice the payload into garbage).
 */
export const VISION_PART_ESTIMATE_CHARS = 4_000;

/**
 * The same estimate expressed in tokens for the TokenLimiterProcessor. The
 * stock limiter feeds every non-text part through JSON.stringify before
 * estimating tokens, so a multi-page PDF upload (~25k estimated "tokens" per
 * 130 KB page) trips the tripwire before generation starts even though the
 * vision encoder only charges ~1-2k tokens per image.
 */
export const VISION_PART_ESTIMATE_TOKENS = Math.round(
  VISION_PART_ESTIMATE_CHARS / CHAR_GUARD_CHARS_PER_TOKEN,
);

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

/**
 * Shared Memory factory. `generateTitle` opts an agent into Mastra's native
 * thread title generation (first-turn completion, agent's own model) — pass
 * `true` for Mastra's default instructions or `{ instructions }` for strict
 * custom ones (both the classic and durable first-turn paths resolve the
 * object form through `resolveTitleGenerationConfig`). Note: Mastra
 * serializes the recent user message for the title call OUTSIDE the agent's
 * inputProcessors, so the context limiter and char-budget guard do not bound
 * it; an oversized first turn can make the provider reject the title
 * request, which Mastra swallows (thread keeps the untitled fallback).
 */
export const TITLE_GENERATION_INSTRUCTIONS = [
  'Generate one concise title for this new conversation.',
  'Target 3-8 words, hard maximum 80 characters, single line.',
  "Summarize the topic of the user's first message; do not answer it.",
  "Do not repeat the user's message verbatim or quote it at length.",
  'No preamble, no explanation, no prefix such as "Title:", no surrounding quotes.',
  "Reply in the same language as the user's message.",
  'Your entire response is used verbatim as the title.',
].join(' ');

export function createAgentMemory(
  options: { generateTitle?: boolean | { instructions: string } } = {},
): Memory {
  return new Memory({
    options: {
      lastMessages: AGENT_MEMORY_LAST_MESSAGES,
      generateTitle: options.generateTitle === true
        ? true
        : options.generateTitle,
    },
  });
}

type VisionCountableMessage = {
  content?: unknown;
  [key: string]: unknown;
};

type TokenCounter = (message: VisionCountableMessage) => Promise<number>;

/**
 * Strip image file parts' base64 payloads so the stock estimator never sees
 * them, and report how many vision parts were found.
 */
function neutralizeVisionParts(
  message: VisionCountableMessage,
): { clone: VisionCountableMessage; visionParts: number } {
  const content = message.content;
  if (
    !content ||
    typeof content !== 'object' ||
    !Array.isArray((content as { parts?: unknown }).parts)
  ) {
    return { clone: message, visionParts: 0 };
  }

  const record = content as { parts: unknown[] };
  let visionParts = 0;
  const parts = record.parts.map((part) => {
    if (!part || typeof part !== 'object') return part;
    const partRecord = part as Record<string, unknown>;
    if (partRecord.type !== 'file') return part;
    const mimeType =
      typeof partRecord.mimeType === 'string' ? partRecord.mimeType : '';
    const data = typeof partRecord.data === 'string' ? partRecord.data : '';
    if (!mimeType.startsWith('image/') && !data.startsWith('data:image/')) {
      return part;
    }
    visionParts += 1;
    return { ...partRecord, data: '' };
  });

  return {
    clone: {
      ...message,
      content: { ...(content as object), parts },
    } as VisionCountableMessage,
    visionParts,
  };
}

/**
 * TokenLimiterProcessor that counts user-message image file parts at the fixed
 * vision-encoder estimate instead of base64 length.
 *
 * The base class types `countInputMessageTokens` private, but it is a regular
 * prototype method at runtime, so the vision-aware counter shadows it as an
 * own property and delegates to the base implementation with image payloads
 * neutralized. Everything else (keep-newest input pruning, tripwires) is
 * inherited unchanged; Chekku wires this only into `inputProcessors`, so the
 * base class's output-truncation path never runs here.
 *
 * Upgrade note: this interception is verified against the pinned
 * `@mastra/core` version. If an upgrade renames, removes, or re-privatizes
 * `countInputMessageTokens` (or stops dispatching `processInputStep` through
 * it dynamically), every input step either throws loudly or silently reverts
 * to raw-base64 counting — re-run the `context-limit` suite and re-inspect
 * the base implementation whenever `@mastra/core` moves.
 */
export class VisionAwareTokenLimiterProcessor extends TokenLimiterProcessor {
  constructor(options: number | { limit: number }) {
    super(options as ConstructorParameters<typeof TokenLimiterProcessor>[0]);

    const self = this as unknown as { countInputMessageTokens: TokenCounter };
    const base = (
      Object.getPrototypeOf(VisionAwareTokenLimiterProcessor.prototype) as {
        countInputMessageTokens: TokenCounter;
      }
    ).countInputMessageTokens;

    self.countInputMessageTokens = async (message) => {
      const { clone, visionParts } = neutralizeVisionParts(message);
      return (
        (await base.call(this, clone)) +
        visionParts * VISION_PART_ESTIMATE_TOKENS
      );
    };
  }
}

export function createAgentContextLimiter(): TokenLimiterProcessor {
  return new VisionAwareTokenLimiterProcessor({
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
      if (typeof part.mediaType === 'string' && part.mediaType.startsWith('image/')) {
        return VISION_PART_ESTIMATE_CHARS;
      }
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
// Base64 payloads (file/media parts) are binary data, not sliceable text: a
// halved data string is a corrupted image, so budget enforcement must drop or
// keep whole parts instead of truncating these fields.
const BINARY_PAYLOAD_FIELDS = new Set(['data', 'image']);

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
      if (PROTOCOL_FIELDS.has(key) || BINARY_PAYLOAD_FIELDS.has(key)) continue;
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

/**
 * A binary payload unit the budget loop may drop whole (never slice):
 * user-message image file parts, standalone media parts, and binary items
 * nested inside tool-result output content arrays. Dropping the nested item
 * keeps the tool-result (and its tool-call pairing) intact.
 */
function isImageFilePart(part: CharBudgetPart): boolean {
  if (part.type !== 'file') return false;
  if (typeof part.mediaType === 'string' && part.mediaType.startsWith('image/')) {
    return true;
  }
  return typeof part.data === 'string' && part.data.startsWith('data:image/');
}

function dropBinaryUnitsToBudget(
  messages: CharBudgetMessage[],
  budget: number,
): CharBudgetMessage[] {
  const clone: CharBudgetMessage[] = structuredClone(messages);

  for (let iteration = 0; iteration < 10_000; iteration++) {
    if (totalPromptChars(clone) <= budget) break;

    let dropped = false;
    // Oldest-first: preserve the newest context as long as possible.
    outer: for (const message of clone) {
      if (message.role === 'system') continue;
      if (!Array.isArray(message.content)) continue;
      for (let p = 0; p < message.content.length; p++) {
        const part = message.content[p] as CharBudgetPart;
        if (isImageFilePart(part) || part.type === 'media') {
          message.content.splice(p, 1);
          dropped = true;
          break outer;
        }
        if (part.type === 'tool-result') {
          const output = part.output as
            | { type?: string; value?: unknown }
            | undefined;
          if (output?.type === 'content' && Array.isArray(output.value)) {
            const items = output.value as Array<{ type?: string; data?: unknown }>;
            for (let v = 0; v < items.length; v++) {
              const item = items[v];
              if (
                item &&
                (item.type === 'media' || item.type === 'file') &&
                (typeof item.data === 'string' || item.data instanceof Uint8Array)
              ) {
                items.splice(v, 1);
                dropped = true;
                break outer;
              }
            }
          }
        }
      }
    }
    if (!dropped) break;
  }

  // Dropping units can empty a non-system message; empty messages would be
  // rejected by providers, so remove them.
  return clone.filter((message) => {
    if (message.role === 'system') return true;
    return !(Array.isArray(message.content) && message.content.length === 0);
  });
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
    // Text handles shrink first; binary payloads are never sliceable.
    const truncated = truncatePromptMessages(survivors, budget);
    // When the overage lives in unsliceable binary payloads (uploaded image
    // parts, tool-result screenshots), slicing text alone cannot reach the
    // budget — drop whole binary units oldest-first so the guard still
    // enforces its bound instead of silently returning an oversized prompt.
    if (totalPromptChars(truncated) > budget) {
      const dropped = dropBinaryUnitsToBudget(truncated, budget);
      if (totalPromptChars(dropped) > budget) {
        return truncatePromptMessages(dropped, budget);
      }
      return dropped;
    }
    return truncated;
  }
  return survivors;
}

/**
 * Estimator-independent backstop that caps the final assembled prompt in
 * characters. The tokenx-based TokenLimiterProcessor under-counts dense tool
 * output (notably base64 screenshots), so heavy multi-step turns can exceed the
 * real model window even when the estimate says they fit. This guard runs last,
 * drops oldest non-system turns (keeping each assistant tool-call with its
 * tool-result so the provider never sees an orphan), truncates oversized text,
 * and — when the remaining overage lives in unsliceable binary payloads —
 * drops whole binary units (image file parts, media parts, binary items
 * inside tool-result output) oldest-first so the budget is still enforced.
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
