import { migrateStoredModelId } from '../server/agent-payload';
import type { ModelRegistry } from './model-registry';
import type { ChekkuAgentSummary } from './types';

export function storedAgentModelId(model: {
  provider: string;
  name: string;
}): string {
  return `${model.provider}/${model.name}`;
}

function canonicalStoredModelId(agent: ChekkuAgentSummary): string | undefined {
  if (agent.source !== 'stored' || !agent.model) return undefined;
  return agent.model.provider === 'openai-compatible'
    ? storedAgentModelId(agent.model)
    : migrateStoredModelId(agent.model);
}

export function storedAgentMigrationTarget(
  agent: ChekkuAgentSummary,
  registry: Pick<ModelRegistry, 'defaultModel' | 'models'>,
): string | undefined {
  const canonical = canonicalStoredModelId(agent);
  if (!canonical) return undefined;

  const target = registry.models.includes(canonical)
    ? canonical
    : registry.defaultModel || registry.models[0];

  if (!target) return undefined;
  return target === storedAgentModelId(agent.model!)
    ? undefined
    : target;
}
