export const STUDIO_TOOL_IDS = [
  'calculator',
  'get-current-time',
  'send-email',
] as const;
export const STUDIO_DELEGATE_IDS = ['qa-web-agent'] as const;
export const STUDIO_MCP_CLIENT_IDS = ['garage', 'searxng'] as const;

export interface AgentPayloadInput {
  id: string;
  name: string;
  description?: string;
  instructions: string;
  model: string;
  tools: string[];
  agents: string[];
  mcpClients: string[];
  memoryEnabled: boolean;
}

function optionRecord(
  values: readonly string[],
): Record<string, Record<string, never>> {
  return Object.fromEntries(values.map((value) => [value, {}]));
}

function readOptionIds(field: unknown): string[] {
  if (!field) return [];

  if (Array.isArray(field)) {
    const ids = field.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const record = entry as Record<string, unknown>;
      if ('value' in record) return readOptionIds(record.value);
      if (typeof record.id === 'string') return [record.id];
      return Object.keys(record);
    });
    return [...new Set(ids)];
  }

  return typeof field === 'object'
    ? Object.keys(field as Record<string, unknown>)
    : [];
}

export function readMcpClientIds(field: unknown): string[] {
  return readOptionIds(field).filter((value) =>
    (STUDIO_MCP_CLIENT_IDS as readonly string[]).includes(value),
  );
}

function endpointModelId(model: string): string {
  const trimmed = model.trim().replace(/^\/+|\/+$/g, '');
  if (!trimmed) throw new Error('Model id is required');

  const canonicalPrefix = 'openai-compatible/gateway/';
  if (trimmed.startsWith(canonicalPrefix)) {
    const endpointModel = trimmed.slice(canonicalPrefix.length);
    if (!endpointModel) throw new Error('Model id is required');
    return endpointModel;
  }

  return trimmed;
}

export function splitModelId(model: string): {
  provider: string;
  name: string;
} {
  return {
    provider: 'openai-compatible',
    name: `gateway/${endpointModelId(model)}`,
  };
}

export function toOpenAICompatibleModelId(model: string): string {
  const config = splitModelId(model);
  return `${config.provider}/${config.name}`;
}

export function migrateStoredModelId(model: {
  provider: string;
  name: string;
}): string {
  if (model.provider === 'openai-compatible') {
    return toOpenAICompatibleModelId(`${model.provider}/${model.name}`);
  }
  return toOpenAICompatibleModelId(model.name);
}

export function toStoredAgentPayload(input: AgentPayloadInput) {
  const lastMessages: number | false = input.memoryEnabled ? 20 : false;
  const tools = input.tools.filter((value) =>
    (STUDIO_TOOL_IDS as readonly string[]).includes(value),
  );
  const agents = input.agents.filter((value) =>
    (STUDIO_DELEGATE_IDS as readonly string[]).includes(value),
  );
  const mcpClients = input.mcpClients.filter((value) =>
    (STUDIO_MCP_CLIENT_IDS as readonly string[]).includes(value),
  );

  return {
    id: input.id,
    name: input.name,
    description: input.description,
    instructions: input.instructions,
    model: splitModelId(input.model),
    memory: {
      options: {
        lastMessages,
      },
    },
    tools: optionRecord(tools),
    agents: optionRecord(agents),
    ...(mcpClients.length > 0 ? {
      mcpClients: Object.fromEntries(
        mcpClients.map((value) => [value, { tools: {} }]),
      ),
    } : {}),
  };
}
