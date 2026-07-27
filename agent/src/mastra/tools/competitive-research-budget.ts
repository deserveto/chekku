const READER_TOOL = 'read_web_page';
const SAVE_TOOL = 'save_competitive_analysis_to_garage';
const READER_CONFIGURATION_MESSAGE = 'Web Reader is not configured.';

const TOOL_LIMITS: Readonly<Record<string, number>> = {
  search_web: 5,
  read_web_page: 8,
  save_competitive_analysis_to_garage: 1,
} as const;

interface BudgetBucket {
  counts: Map<string, number>;
  terminalReaderConfig: boolean;
}

const buckets = new Map<string, BudgetBucket>();

function bucketKey(agentId: string, threadId: string): string {
  return `${agentId}:${threadId}`;
}

function getBucket(agentId: string, threadId: string): BudgetBucket {
  const key = bucketKey(agentId, threadId);
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { counts: new Map(), terminalReaderConfig: false };
    buckets.set(key, bucket);
  }
  return bucket;
}

function isReaderConfigurationError(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(READER_CONFIGURATION_MESSAGE);
  if (value instanceof Error) {
    return value.message === READER_CONFIGURATION_MESSAGE || isReaderConfigurationError(value.cause);
  }
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.message === 'string' && record.message.includes(READER_CONFIGURATION_MESSAGE)) return true;
  if (record.category === 'configuration') return true;
  return isReaderConfigurationError(record.cause);
}

interface AgentRunContext {
  agent?: { agentId?: string; threadId?: string };
  abortSignal?: AbortSignal;
}

type AnyTool = { execute?: (...args: never[]) => Promise<unknown> } & Record<string, unknown>;

export function withCompetitiveResearchBudget<T>(
  toolName: string,
  tool: T,
): T {
  const t = tool as unknown as AnyTool;
  const limit = TOOL_LIMITS[toolName];
  const isReader = toolName === READER_TOOL;
  const originalExecute = t.execute;
  if (!originalExecute || limit === undefined) return tool;

  const budgetedExecute = async (input: unknown, context: unknown) => {
    const ctx = (context ?? {}) as AgentRunContext;
    const agentId = ctx.agent?.agentId;
    const threadId = ctx.agent?.threadId;
    if (!agentId || !threadId) {
      return originalExecute(input as never, context as never);
    }
    const bucket = getBucket(agentId, threadId);

    if (isReader && bucket.terminalReaderConfig) {
      throw new Error(READER_CONFIGURATION_MESSAGE);
    }
    const used = bucket.counts.get(toolName) ?? 0;
    if (used >= limit) {
      if (toolName === 'save_competitive_analysis_to_garage') {
        throw new Error('Competitive analysis has already been saved for this run.');
      }
      throw new Error(`${toolName} budget exhausted for this competitive run.`);
    }

    try {
      const result = await originalExecute(input as never, context as never);
      bucket.counts.set(toolName, used + 1);
      return result;
    } catch (error) {
      if (toolName !== SAVE_TOOL) {
        bucket.counts.set(toolName, used + 1);
      }
      if (isReader && isReaderConfigurationError(error)) {
        bucket.terminalReaderConfig = true;
      }
      throw error;
    }
  };

  return { ...t, execute: budgetedExecute } as unknown as T;
}
