export interface SearxngConfigurationInput {
  baseUrl: string;
  apiKey: string;
}

export interface SearxngConfiguration {
  baseUrl: URL;
  apiKey?: string;
}

const INVALID_CONFIGURATION = 'SearXNG search configuration is invalid.';

export function parseSearxngConfiguration(
  input: SearxngConfigurationInput,
): SearxngConfiguration | undefined {
  if (!input.baseUrl.trim()) return undefined;
  try {
    const baseUrl = new URL(input.baseUrl);
    if (!['http:', 'https:'].includes(baseUrl.protocol)
      || baseUrl.username
      || baseUrl.password
      || baseUrl.search
      || baseUrl.hash
      || /[\r\n]/.test(input.apiKey)) {
      throw new Error(INVALID_CONFIGURATION);
    }
    baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, '')}/`;
    return { baseUrl, ...(input.apiKey ? { apiKey: input.apiKey } : {}) };
  } catch {
    throw new Error(INVALID_CONFIGURATION);
  }
}

export function searxngEndpoint(
  config: SearxngConfiguration,
  path: 'config' | 'search',
): URL {
  return new URL(path, config.baseUrl);
}
