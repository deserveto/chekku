import { registerApiRoute } from '@mastra/core/server';
import { env } from '../../config/env.js';
import {
  getConfiguredModelIds,
  getModelDisplayName,
  isModelConfigured,
} from '../../providers/model.js';
import { discoverOpenAICompatibleModels } from '../gateways/openai-compatible-discovery.js';
import { toOpenAICompatibleRouterId } from '../gateways/openai-compatible-model.js';

export interface ModelRouteInput {
  configured: boolean;
  displayName: string;
  defaultModel: string;
  modelIds: readonly string[];
}

export function toModelRoutePayload(input: ModelRouteInput): {
  configured: boolean;
  displayName: string;
  defaultModel: string;
  models: string[];
} {
  return {
    configured: input.configured,
    displayName: input.displayName,
    defaultModel:
      input.configured && input.defaultModel
        ? toOpenAICompatibleRouterId(input.defaultModel)
        : '',
    models: input.configured
      ? [...new Set(input.modelIds.map(toOpenAICompatibleRouterId))]
      : [],
  };
}

export const modelsRoute = registerApiRoute('/models', {
  method: 'GET',
  requiresAuth: false,
  handler: async (c: any) => {
    const configured = isModelConfigured();
    const fallback = getConfiguredModelIds();
    const discovered = configured
      ? await discoverOpenAICompatibleModels({
          baseUrl: env.LLM_BASE_URL,
          apiKey: env.LLM_API_KEY,
          defaultModel: env.LLM_DEFAULT_MODEL,
          curatedModels: fallback,
        })
      : [];

    return c.json(
      toModelRoutePayload({
        configured,
        displayName: getModelDisplayName(),
        defaultModel: env.LLM_DEFAULT_MODEL,
        modelIds: discovered,
      }),
    );
  },
});
