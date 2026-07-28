import type { InputProcessor } from '@mastra/core/processors';

const SEARCH_TOOL = 'search_web';
const READER_TOOL = 'read_web_page';
const READER_CONFIGURATION_MESSAGE = 'Web Reader is not configured.';

const TOOL_LIMITS: Readonly<Record<string, number>> = {
  [SEARCH_TOOL]: 8,
  [READER_TOOL]: 14,
};

export const COMPETITIVE_RESEARCH_TERMINAL_INSTRUCTION =
  'Web Reader configuration failed for this run. Do not call read_web_page again. Return the incomplete competitive-analysis branch using only successful page evidence from this run. Do not save it and do not emit Saved analysisId:.';

interface ToolInvocationPart {
  type?: string;
  toolInvocation?: {
    toolName?: string;
    state?: string;
    result?: unknown;
    error?: unknown;
  };
}

interface ResearchMessage {
  role?: string;
  content?: unknown;
}

export interface CompetitiveResearchDecision {
  activeTools: string[];
  terminalConfigurationFailure: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isReaderConfigurationError(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.includes(READER_CONFIGURATION_MESSAGE);
  }
  if (value instanceof Error) {
    return value.message === READER_CONFIGURATION_MESSAGE
      || isReaderConfigurationError(value.cause);
  }
  if (!isRecord(value)) return false;
  return value.message === READER_CONFIGURATION_MESSAGE
    || value.category === 'configuration'
    || (typeof value.message === 'string' && value.message.includes(READER_CONFIGURATION_MESSAGE))
    || isReaderConfigurationError(value.cause);
}

function extractParts(message: ResearchMessage): ToolInvocationPart[] {
  const content = message?.content;
  if (Array.isArray(content)) return content as ToolInvocationPart[];
  if (isRecord(content) && Array.isArray(content.parts)) {
    return content.parts as ToolInvocationPart[];
  }
  return [];
}

function sliceCurrentRun(messages: readonly ResearchMessage[]): readonly ResearchMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      return messages.slice(i);
    }
  }
  return messages;
}

export function getCompetitiveResearchDecision(
  messages: readonly ResearchMessage[],
  availableTools: readonly string[],
): CompetitiveResearchDecision {
  const counts = new Map<string, number>();
  let terminalConfigurationFailure = false;

  const currentRun = sliceCurrentRun(messages);
  for (const message of currentRun) {
    for (const part of extractParts(message)) {
      const invocation = part?.toolInvocation;
      if (!invocation || typeof invocation.toolName !== 'string') continue;
      if (part.type === 'tool-invocation' || part.type === 'tool-call') {
        counts.set(invocation.toolName, (counts.get(invocation.toolName) ?? 0) + 1);
      }
      if (invocation.toolName === READER_TOOL) {
        terminalConfigurationFailure ||= isReaderConfigurationError(invocation.result)
          || isReaderConfigurationError(invocation.error);
      }
    }
  }

  const activeTools = availableTools.filter((toolName) => {
    if (toolName === READER_TOOL && terminalConfigurationFailure) return false;
    const limit = TOOL_LIMITS[toolName];
    return limit === undefined || (counts.get(toolName) ?? 0) < limit;
  });

  return { activeTools, terminalConfigurationFailure };
}

export function createCompetitiveResearchGuard(): InputProcessor {
  return {
    id: 'competitive-research-guard',
    processInputStep: (args) => {
      const raw = args as {
        messages?: unknown;
        messageList?: { get?: { all?: { db?: () => unknown } } };
        tools?: Record<string, unknown>;
        activeTools?: string[];
        systemMessages?: unknown[];
      };
      const messageSource = raw.messages ?? raw.messageList?.get?.all?.db?.();
      const messageList = Array.isArray(messageSource)
        ? (messageSource as ResearchMessage[])
        : [];
      const availableTools = raw.activeTools ?? Object.keys(raw.tools ?? {});
      const decision = getCompetitiveResearchDecision(messageList, availableTools);
      const toolsChanged = decision.activeTools.length !== availableTools.length;
      if (!toolsChanged && !decision.terminalConfigurationFailure) return;

      const existingSystemMessages = Array.isArray(raw.systemMessages) ? raw.systemMessages : [];
      const result: Record<string, unknown> = { activeTools: decision.activeTools };
      if (decision.terminalConfigurationFailure) {
        result.systemMessages = [
          ...existingSystemMessages,
          { role: 'system', content: COMPETITIVE_RESEARCH_TERMINAL_INSTRUCTION },
        ];
      }
      return result as { activeTools: string[] };
    },
  };
}
