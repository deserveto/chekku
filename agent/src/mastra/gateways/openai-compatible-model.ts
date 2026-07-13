export const OPENAI_COMPATIBLE_GATEWAY_ID = 'openai-compatible';
export const OPENAI_COMPATIBLE_PROVIDER_ID = 'gateway';

const CANONICAL_PREFIX = `${OPENAI_COMPATIBLE_GATEWAY_ID}/${OPENAI_COMPATIBLE_PROVIDER_ID}/`;

function requireModelId(value: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '');
  if (!trimmed) throw new Error('Model id is required');
  return trimmed;
}

export function stripOpenAICompatibleRouterId(value: string): string {
  const modelId = requireModelId(value);
  if (modelId.startsWith(CANONICAL_PREFIX)) {
    return requireModelId(modelId.slice(CANONICAL_PREFIX.length));
  }
  return modelId;
}

export function toOpenAICompatibleRouterId(value: string): string {
  return `${CANONICAL_PREFIX}${stripOpenAICompatibleRouterId(value)}`;
}

export function legacyStoredModelToRouterId(modelName: string): string {
  return toOpenAICompatibleRouterId(modelName);
}

export function toStoredModelConfig(value: string): {
  provider: string;
  name: string;
} {
  return {
    provider: OPENAI_COMPATIBLE_GATEWAY_ID,
    name: `${OPENAI_COMPATIBLE_PROVIDER_ID}/${stripOpenAICompatibleRouterId(value)}`,
  };
}
