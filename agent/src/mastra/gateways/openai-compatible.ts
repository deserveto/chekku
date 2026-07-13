import {
  MastraModelGateway,
  type ProviderConfig,
} from '@mastra/core/llm';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible-v5';

import { env } from '../../config/env.js';
import { getConfiguredModelIds } from '../../providers/model.js';
import { discoverOpenAICompatibleModels } from './openai-compatible-discovery.js';
import {
  OPENAI_COMPATIBLE_GATEWAY_ID,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  stripOpenAICompatibleRouterId,
} from './openai-compatible-model.js';
import { normalizeSystemMessages } from './system-message-normalizer.js';

export class OpenAICompatibleGateway extends MastraModelGateway {
  readonly id = OPENAI_COMPATIBLE_GATEWAY_ID;
  readonly name = 'OpenAI-compatible Gateway';

  async fetchProviders(): Promise<Record<string, ProviderConfig>> {
    const fallback = getConfiguredModelIds().map(
      stripOpenAICompatibleRouterId,
    );

    const models = await discoverOpenAICompatibleModels({
      baseUrl: env.LLM_BASE_URL,
      apiKey: env.LLM_API_KEY,
      defaultModel: env.LLM_DEFAULT_MODEL,
      curatedModels: fallback,
    });

    return {
      [OPENAI_COMPATIBLE_PROVIDER_ID]: {
        name: env.LLM_DISPLAY_NAME,
        models,
        apiKeyEnvVar: 'LLM_API_KEY',
        gateway: this.id,
        url: env.LLM_BASE_URL,
      },
    };
  }

  buildUrl(): string {
    const baseUrl = env.LLM_BASE_URL
      .trim()
      .replace(/\/+$/, '');

    if (!baseUrl) {
      throw new Error(
        'Missing LLM_BASE_URL environment variable',
      );
    }

    return baseUrl;
  }

  async getApiKey(): Promise<string> {
    const apiKey = env.LLM_API_KEY.trim();

    if (!apiKey) {
      throw new Error(
        'Missing LLM_API_KEY environment variable',
      );
    }

    return apiKey;
  }

  async resolveLanguageModel({
    modelId,
    providerId,
    apiKey,
  }: {
    modelId: string;
    providerId: string;
    apiKey: string;
  }) {
    const model = createOpenAICompatible({
      name: providerId,
      apiKey,
      baseURL: this.buildUrl(),
      supportsStructuredOutputs: true,
    }).chatModel(modelId);

    /*
     * Some hosted vLLM chat templates reject system messages that
     * appear after user, assistant, or tool messages.
     *
     * Mastra Browser, Memory, or processors may append additional
     * system context after the initial prompt. Normalize the final
     * prompt immediately before it reaches the provider.
     */
    return {
      specificationVersion: model.specificationVersion,
      provider: model.provider,
      modelId: model.modelId,
      supportedUrls: model.supportedUrls,

      doGenerate: (
        options: Parameters<typeof model.doGenerate>[0],
      ) =>
        model.doGenerate({
          ...options,
          prompt: normalizeSystemMessages(options.prompt),
        }),

      doStream: (
        options: Parameters<typeof model.doStream>[0],
      ) =>
        model.doStream({
          ...options,
          prompt: normalizeSystemMessages(options.prompt),
        }),
    };
  }
}
