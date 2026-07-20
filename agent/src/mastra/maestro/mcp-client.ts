import { MCPClient, type MastraMCPServerDefinition } from '@mastra/mcp';

export const MAESTRO_MCP_SERVER_NAME = 'maestro';

export const MAESTRO_TOOL_ALLOWLIST = [
  'list_devices',
  'inspect_screen',
  'take_screenshot',
  'cheat_sheet',
  'run',
] as const;

export function namespacedAllowlist(): readonly string[] {
  return MAESTRO_TOOL_ALLOWLIST.map((name) => `${MAESTRO_MCP_SERVER_NAME}_${name}`);
}

const ALLOWED_KEYS = new Set<string>(namespacedAllowlist());

export function filterMaestroTools<T extends Record<string, unknown>>(tools: T): Record<string, T[string]> {
  const result: Record<string, T[string]> = {};
  for (const [key, value] of Object.entries(tools)) {
    if (ALLOWED_KEYS.has(key)) result[key] = value as T[string];
  }
  return result;
}

export const MAESTRO_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
  'JAVA_HOME',
  'SYSTEMROOT',
  'TEMP',
  'LOCALAPPDATA',
  'APPDATA',
] as const;

export function sanitizeMaestroEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of MAESTRO_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) env[key] = value;
  }
  return env;
}

export function resolveMaestroSpawn(command: string): { command: string; preArgs: string[] } {
  if (process.platform === 'win32' && /\.(bat|cmd)$/i.test(command)) {
    return { command: 'cmd.exe', preArgs: ['/c', command] };
  }
  return { command, preArgs: [] };
}

export interface CreateMaestroMcpClientOptions {
  command: string;
  timeoutMs: number;
}

export function createMaestroMcpClient(options: CreateMaestroMcpClientOptions): MCPClient {
  const { command, preArgs } = resolveMaestroSpawn(options.command);
  const server: MastraMCPServerDefinition = {
    command,
    args: [...preArgs, 'mcp'],
    env: sanitizeMaestroEnv(),
  };
  return new MCPClient({
    servers: { [MAESTRO_MCP_SERVER_NAME]: server },
    timeout: options.timeoutMs,
  });
}
