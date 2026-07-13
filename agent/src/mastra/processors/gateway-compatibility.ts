import type { InputProcessor } from '@mastra/core/processors';

/**
 * Rafiqspace's hosted vLLM currently accepts one leading system message.
 * Mastra adds browser context as a second system message, so coalesce those
 * messages only for the custom gateway without changing stored history.
 */
export const gatewayCompatibilityProcessor: InputProcessor = {
  id: 'gateway-system-message-compatibility',
  processLLMRequest: ({ prompt, model }) => {
    if (!model.provider.startsWith('gateway.')) return;

    const systemMessages = prompt.filter((message) => message.role === 'system');
    if (systemMessages.length <= 1) return;

    const mergedSystemMessage = {
      role: 'system' as const,
      content: systemMessages.map((message) => message.content).join('\n\n'),
    };

    return {
      prompt: [
        mergedSystemMessage,
        ...prompt.filter((message) => message.role !== 'system'),
      ],
    };
  },
};
