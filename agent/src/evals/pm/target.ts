import type { Agent } from '@mastra/core/agent';
import type { ScorerRunInputForAgent } from '@mastra/core/evals';
import type { MastraDBMessage } from '@mastra/core/memory';

type DurableOutputForScoring = {
  text: string;
  messages: readonly MastraDBMessage[];
  rememberedMessages?: readonly MastraDBMessage[];
};

function textMessage(
  id: string,
  role: 'user' | 'assistant',
  text: string,
): MastraDBMessage {
  return {
    id,
    role,
    type: 'text',
    createdAt: new Date(),
    content: {
      format: 2,
      parts: [{ type: 'text', text }],
    },
  };
}

function hasText(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.some(hasText);
  if (typeof value !== 'object' || value === null) return false;

  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text.trim() !== '';
  if ('parts' in record) return hasText(record.parts);
  if ('content' in record) return hasText(record.content);
  return false;
}

function collectText(value: unknown, into: string[]): void {
  if (typeof value === 'string') {
    into.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, into);
    return;
  }
  if (typeof value !== 'object' || value === null) return;

  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string') into.push(record.text);
  if ('parts' in record) collectText(record.parts, into);
  else if ('content' in record) collectText(record.content, into);
}

function hasAssistantText(messages: readonly MastraDBMessage[]): boolean {
  return messages.some(
    (message) => message.role === 'assistant' && hasText(message.content),
  );
}

export function buildDurableScoringData(
  input: unknown,
  output: DurableOutputForScoring,
): {
  input: Omit<ScorerRunInputForAgent, 'runId'>;
  output: MastraDBMessage[];
} {
  const inputText = typeof input === 'string' ? input : JSON.stringify(input);
  // FullOutput.messages carries input + memory history + response; native
  // Mastra scoringData is response-only, so drop remembered turns by id.
  const rememberedIds = new Set(
    (output.rememberedMessages ?? []).map((message) => message.id),
  );
  const responseMessages = rememberedIds.size > 0
    ? output.messages.filter((message) => !rememberedIds.has(message.id))
    : output.messages;
  // The durable message list can keep only the intro text part that preceded
  // a tool call, while the final answer lives solely in output.text. Always
  // guarantee the final text is scored: append it unless an assistant message
  // already contains it.
  const finalText = output.text.trim();
  const collected: string[] = [];
  for (const message of responseMessages) {
    if (message.role === 'assistant') collectText(message.content, collected);
  }
  const finalTextPresent = finalText !== '' && collected.join('\n').includes(finalText);
  const messages = hasAssistantText(responseMessages) && (finalText === '' || finalTextPresent)
    ? [...responseMessages]
    : [
        ...responseMessages,
        textMessage('pm-eval-assistant', 'assistant', output.text),
      ];

  return {
    input: {
      inputMessages: [textMessage('pm-eval-user', 'user', inputText)],
      rememberedMessages: [],
      systemMessages: [],
      taggedSystemMessages: {},
    },
    output: messages,
  };
}

export function createDurableEvalTarget(agent: Agent): Agent {
  return {
    id: agent.id,
    name: agent.name,
    getModel: agent.getModel.bind(agent),
    getMastraInstance: agent.getMastraInstance.bind(agent),
    generate: async (...args: Parameters<Agent['generate']>) => {
      const [input] = args;
      const output = await agent.generate(...args);
      if (output.scoringData) return output;

      return {
        ...output,
        scoringData: buildDurableScoringData(input, output),
      };
    },
  } as unknown as Agent;
}
