export interface OpenAICompatibleDiscoveryOptions {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  curatedModels: readonly string[];
  fetchImpl?: typeof fetch;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function fallbackModelIds(
  curatedModels: readonly string[],
  defaultModel: string,
): string[] {
  return unique([...curatedModels, defaultModel]);
}

function modelsUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) throw new Error('LLM_BASE_URL is required');
  return `${normalized}/models`;
}

export async function discoverOpenAICompatibleModels({
  baseUrl,
  apiKey,
  defaultModel,
  curatedModels,
  fetchImpl = fetch,
}: OpenAICompatibleDiscoveryOptions): Promise<string[]> {
  const fallback = fallbackModelIds(curatedModels, defaultModel);

  try {
    const response = await fetchImpl(modelsUrl(baseUrl), {
      headers: {
        Accept: 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) return fallback;

    const body = (await response.json()) as {
      data?: Array<{ id?: unknown }>;
    };
    const discovered = unique(
      (body.data ?? []).flatMap((entry) =>
        typeof entry.id === 'string' ? [entry.id] : [],
      ),
    );

    return discovered.length ? discovered : fallback;
  } catch {
    return fallback;
  }
}
