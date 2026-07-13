import { env } from '../config/env.js';
import { toOpenAICompatibleRouterId } from '../mastra/gateways/openai-compatible-model.js';

export interface ModelEnvironment {
  LLM_BASE_URL: string;
  LLM_API_KEY: string;
  LLM_DEFAULT_MODEL: string;
  LLM_DISPLAY_NAME: string;
  LLM_MODELS: string;
}

function current(source?: ModelEnvironment): ModelEnvironment {
  return source ?? env;
}

function curatedModels(value: string): string[] {
  return value
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
}

export function isModelConfigured(source?: ModelEnvironment): boolean {
  const value = current(source);
  return Boolean(
    value.LLM_BASE_URL.trim() &&
      value.LLM_API_KEY.trim() &&
      value.LLM_DEFAULT_MODEL.trim(),
  );
}

export function getServerModel(source?: ModelEnvironment): string {
  const value = current(source);
  if (!isModelConfigured(value)) {
    throw new Error(
      'No model configured. Set LLM_BASE_URL, LLM_API_KEY, and LLM_DEFAULT_MODEL in agent/.env.',
    );
  }
  return toOpenAICompatibleRouterId(value.LLM_DEFAULT_MODEL);
}

export function getConfiguredModelIds(
  source?: ModelEnvironment,
): string[] {
  const value = current(source);
  const models = [
    ...curatedModels(value.LLM_MODELS),
    value.LLM_DEFAULT_MODEL,
  ];
  return [
    ...new Set(
      models
        .filter(Boolean)
        .map((model) => toOpenAICompatibleRouterId(model)),
    ),
  ];
}

export function getModelDisplayName(source?: ModelEnvironment): string {
  const value = current(source);
  return (
    value.LLM_DISPLAY_NAME.trim() ||
    value.LLM_DEFAULT_MODEL.trim() ||
    'OpenAI-compatible endpoint'
  );
}
