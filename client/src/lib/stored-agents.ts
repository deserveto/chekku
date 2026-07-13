import type {
  GetAgentResponse,
  StoredAgentResponse,
} from '@mastra/client-js';
import {
  toStoredAgentPayload,
} from '@/server/agent-payload';
import { mastraClient } from './mastra-client';
import { buildApiMessage } from './agents-helpers';
import { storedAgentMigrationTarget } from './stored-agent-migration';
import type { ModelRegistry } from './model-registry';
import {
  MAIN_AGENT_ID,
  type ChekkuAgentDetail,
  type ChekkuAgentSummary,
} from './types';

export interface AgentFormInput {
  name: string;
  description?: string;
  instructions: string;
  model: string;
  tools?: string[];
  agents?: string[];
  memoryEnabled: boolean;
}

export class AgentApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'AgentApiError';
    this.status = status;
  }
}

type StoredModel = StoredAgentResponse['model'];

function readModel(
  field: StoredModel,
): { provider: string; name: string } | undefined {
  if (!field) return undefined;

  if (Array.isArray(field)) {
    const match = field.find(
      (variant) =>
        variant &&
        typeof variant === 'object' &&
        'value' in variant &&
        variant.value,
    );
    if (!match) return undefined;
    return {
      provider: String(match.value.provider),
      name: String(match.value.name),
    };
  }

  return {
    provider: String(field.provider),
    name: String(field.name),
  };
}

type StoredMemory = StoredAgentResponse['memory'];

function readMemoryEnabled(memory: StoredMemory): boolean {
  if (!memory) return false;

  const config = Array.isArray(memory)
    ? memory.find(
        (variant) =>
          variant &&
          typeof variant === 'object' &&
          'value' in variant &&
          variant.value,
      )?.value
    : memory;

  if (!config || typeof config !== 'object') return false;

  const lastMessages = (
    config as {
      options?: { lastMessages?: number | false };
    }
  ).options?.lastMessages;

  return lastMessages !== false;
}

function readInstructions(
  instructions: StoredAgentResponse['instructions'],
): string {
  if (typeof instructions === 'string') return instructions;
  if (!Array.isArray(instructions)) return '';

  return instructions
    .map((block) =>
      block &&
      typeof block === 'object' &&
      'content' in block &&
      typeof (block as { content?: unknown }).content === 'string'
        ? (block as { content: string }).content
        : '',
    )
    .filter(Boolean)
    .join('\n');
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

  if (typeof field === 'object') {
    return Object.keys(field as Record<string, unknown>);
  }

  return [];
}

function summarizeStored(agent: StoredAgentResponse): ChekkuAgentSummary {
  const status =
    agent.status === 'draft' ||
    agent.status === 'published' ||
    agent.status === 'archived'
      ? agent.status
      : undefined;

  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    source: 'stored',
    model: readModel(agent.model),
    status,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

function summarizeCode(agent: GetAgentResponse): ChekkuAgentSummary {
  const first = agent.modelList?.[0]?.model;

  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    source: 'code',
    model: first
      ? {
          provider: first.provider,
          name: first.modelId,
        }
      : undefined,
    status: agent.status,
  };
}

async function wrap<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const reason = error as {
      status?: number;
      statusCode?: number;
      message?: string;
      body?: { message?: string };
    };
    const status = reason.status ?? reason.statusCode;
    const serverMessage = reason.body?.message ?? reason.message;
    throw new AgentApiError(
      buildApiMessage(status ?? 0, serverMessage),
      status,
    );
  }
}

export async function listStoredAgents(): Promise<ChekkuAgentSummary[]> {
  const response = await wrap(() =>
    mastraClient.listStoredAgents({ perPage: 100 }),
  );
  return response.agents.map(summarizeStored);
}

export async function createStoredAgent(
  id: string,
  input: AgentFormInput,
): Promise<ChekkuAgentSummary> {
  const model = input.model;

  const payload = toStoredAgentPayload({
    id,
    ...input,
    model,
    tools: input.tools ?? [],
    agents: input.agents ?? [],
  });

  const created = await wrap(() =>
    mastraClient.createStoredAgent(payload),
  );

  return summarizeStored(created);
}

export async function getStoredAgent(
  id: string,
): Promise<ChekkuAgentDetail> {
  if (id === MAIN_AGENT_ID) {
    throw new AgentApiError(
      'main-agent is code-defined and cannot be edited.',
      400,
    );
  }

  const detail = await wrap(() =>
    mastraClient.getStoredAgent(id).details(),
  );

  const record = detail as unknown as Record<string, unknown>;

  return {
    ...summarizeStored(detail),
    instructions: readInstructions(detail.instructions),
    memoryEnabled: readMemoryEnabled(detail.memory),
    tools: readOptionIds(record.tools),
    agents: readOptionIds(record.agents),
  };
}

export async function updateStoredAgent(
  id: string,
  input: AgentFormInput,
): Promise<ChekkuAgentSummary> {
  const model = input.model;

  const fullPayload = toStoredAgentPayload({
    id,
    ...input,
    model,
    tools: input.tools ?? [],
    agents: input.agents ?? [],
  });
  const { id: payloadId, ...payload } = fullPayload;
  void payloadId;

  const updated = await wrap(() =>
    mastraClient.getStoredAgent(id).update(payload),
  );

  return summarizeStored(updated);
}


export async function ensureStoredAgentUsesServerGateway(
  agent: ChekkuAgentSummary,
  registry: Pick<ModelRegistry, 'defaultModel' | 'models'>,
): Promise<void> {
  const model = storedAgentMigrationTarget(agent, registry);
  if (!model) return;

  const detail = await getStoredAgent(agent.id);
  await updateStoredAgent(agent.id, {
    name: detail.name,
    description: detail.description,
    instructions: detail.instructions,
    model,
    tools: detail.tools,
    agents: detail.agents,
    memoryEnabled: detail.memoryEnabled,
  });
}

export async function deleteStoredAgent(id: string): Promise<void> {
  if (id === MAIN_AGENT_ID) {
    throw new AgentApiError(
      'main-agent is protected and cannot be deleted.',
      400,
    );
  }

  await wrap(() => mastraClient.getStoredAgent(id).delete());
}

export async function listAllAgents(): Promise<ChekkuAgentSummary[]> {
  let codeMap: Record<string, GetAgentResponse> = {};
  let stored: ChekkuAgentSummary[] = [];
  let codeFailed = false;
  let storedFailed = false;

  try {
    codeMap = await wrap(() => mastraClient.listAgents());
  } catch {
    codeFailed = true;
  }

  try {
    stored = await listStoredAgents();
  } catch {
    storedFailed = true;
  }

  if (codeFailed && storedFailed) {
    throw new AgentApiError(
      'Could not reach the Mastra server to load agents.',
    );
  }

  const codeAgents = Object.values(codeMap)
    .filter(
      (agent): agent is GetAgentResponse =>
        Boolean(agent) && agent.source !== 'stored',
    )
    .map(summarizeCode);

  const storedIds = new Set(stored.map((agent) => agent.id));
  const merged = [
    ...codeAgents.filter((agent) => !storedIds.has(agent.id)),
    ...stored,
  ];

  const mainEntry = merged.find((agent) => agent.id === MAIN_AGENT_ID) ?? {
    id: MAIN_AGENT_ID,
    name: 'Chekku Assistant',
    description: 'General-purpose studio entry agent.',
    source: 'code' as const,
  };

  return [
    mainEntry,
    ...merged.filter((agent) => agent.id !== MAIN_AGENT_ID),
  ];
}
