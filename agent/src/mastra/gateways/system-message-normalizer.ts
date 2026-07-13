type PromptMessage = {
  role: string;
  content: unknown;
  providerOptions?: unknown;
};

export function normalizeSystemMessages<T extends PromptMessage>(
  prompt: readonly T[],
): T[] {
  const systemMessages = prompt.filter(
    (message) => message.role === 'system',
  );

  if (systemMessages.length === 0) {
    return [...prompt];
  }

  if (
    systemMessages.length === 1 &&
    prompt[0]?.role === 'system'
  ) {
    return [...prompt];
  }

  const mergedContent = systemMessages
    .map((message) => {
      if (typeof message.content !== 'string') {
        throw new TypeError(
          'System message content must be a string',
        );
      }

      return message.content.trim();
    })
    .filter(Boolean)
    .join('\n\n');

  const nonSystemMessages = prompt.filter(
    (message) => message.role !== 'system',
  );

  if (!mergedContent) {
    return nonSystemMessages;
  }

  return [
    {
      ...systemMessages[0],
      content: mergedContent,
    },
    ...nonSystemMessages,
  ];
}
