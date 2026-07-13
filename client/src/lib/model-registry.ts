export interface ModelRegistry {
  configured: boolean;
  displayName: string;
  defaultModel: string;
  models: string[];
}

export function normalizeModelRegistry(payload: unknown): ModelRegistry {
  const record =
    payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>)
      : {};
  const models = Array.isArray(record.models)
    ? [...new Set(record.models.filter(
        (value): value is string =>
          typeof value === 'string' && value.trim().length > 0,
      ))]
    : [];
  const requestedDefault =
    typeof record.defaultModel === 'string'
      ? record.defaultModel
      : '';
  const defaultModel = models.includes(requestedDefault)
    ? requestedDefault
    : models[0] || '';

  return {
    configured: record.configured === true && models.length > 0,
    displayName:
      typeof record.displayName === 'string' && record.displayName.trim()
        ? record.displayName
        : 'OpenAI-compatible endpoint',
    defaultModel,
    models,
  };
}

export async function loadModelRegistry(): Promise<ModelRegistry> {
  const response = await fetch('/api/agent/models');
  if (!response.ok) {
    throw new Error(`Model registry returned ${response.status}`);
  }

  return normalizeModelRegistry(await response.json());
}
