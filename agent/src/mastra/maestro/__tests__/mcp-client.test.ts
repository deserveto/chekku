import { describe, expect, it } from 'vitest';

import {
  MAESTRO_TOOL_ALLOWLIST,
  filterMaestroTools,
  namespacedAllowlist,
  resolveMaestroSpawn,
  sanitizeMaestroEnv,
} from '../mcp-client.js';

describe('Maestro MCP allowlist', () => {
  it('exposes exactly the verified built-in maestro mcp tools', () => {
    expect([...MAESTRO_TOOL_ALLOWLIST]).toEqual([
      'list_devices',
      'inspect_screen',
      'take_screenshot',
      'cheat_sheet',
      'run',
    ]);
    expect(MAESTRO_TOOL_ALLOWLIST).not.toContain('run_flow_files');
    expect(MAESTRO_TOOL_ALLOWLIST).not.toContain('run_flow');
    expect(MAESTRO_TOOL_ALLOWLIST).not.toContain('tap_on');
  });

  it('namespaces every allowlisted tool with the maestro_ prefix', () => {
    expect(namespacedAllowlist()).toContain('maestro_list_devices');
    expect(namespacedAllowlist()).toContain('maestro_run');
  });

  it('keeps only the allowlisted tools and drops run_flow_files/cloud/viewer/unknown', () => {
    const tools = {
      maestro_list_devices: { id: 'list_devices' },
      maestro_inspect_screen: { id: 'inspect_screen' },
      maestro_take_screenshot: { id: 'take_screenshot' },
      maestro_cheat_sheet: { id: 'cheat_sheet' },
      maestro_run: { id: 'run' },
      maestro_run_flow_files: { id: 'run_flow_files' },
      maestro_run_on_cloud: { id: 'run_on_cloud' },
      maestro_list_cloud_devices: { id: 'list_cloud_devices' },
      maestro_get_cloud_run_status: { id: 'get_cloud_run_status' },
      maestro_open_maestro_viewer: { id: 'open_maestro_viewer' },
      maestro_secret_thing: { id: 'secret' },
    };

    const filtered = filterMaestroTools(tools);
    expect(Object.keys(filtered).sort()).toEqual([
      'maestro_cheat_sheet',
      'maestro_inspect_screen',
      'maestro_list_devices',
      'maestro_run',
      'maestro_take_screenshot',
    ]);
  });

  it('sanitizeMaestroEnv keeps only PATH/HOME/Android/Java/Windows vars and drops all secrets', () => {
    const env = sanitizeMaestroEnv({
      PATH: '/usr/bin',
      HOME: '/home/user',
      ANDROID_HOME: '/android/sdk',
      JAVA_HOME: '/java',
      SYSTEMROOT: 'C:\\Windows',
      TEMP: '/tmp',
      LLM_API_KEY: 'secret-llm',
      GARAGE_SECRET_ACCESS_KEY: 'secret-garage',
      RESEND_API_KEY: 'secret-resend',
      TELEGRAM_BOT_TOKEN: 'secret-tg',
      RANDOM_UNUSED: 'ignored',
    } as NodeJS.ProcessEnv);

    expect(Object.keys(env).sort()).toEqual(['ANDROID_HOME', 'HOME', 'JAVA_HOME', 'PATH', 'SYSTEMROOT', 'TEMP']);
    expect(env.PATH).toBe('/usr/bin');
    expect(env).not.toHaveProperty('LLM_API_KEY');
    expect(env).not.toHaveProperty('GARAGE_SECRET_ACCESS_KEY');
    expect(env).not.toHaveProperty('RESEND_API_KEY');
    expect(env).not.toHaveProperty('TELEGRAM_BOT_TOKEN');
  });

  it('resolveMaestroSpawn wraps .bat/.cmd through cmd.exe on Windows and passes through otherwise', () => {
    expect(resolveMaestroSpawn('maestro')).toEqual({ command: 'maestro', preArgs: [] });
    expect(resolveMaestroSpawn('/usr/local/bin/maestro')).toEqual({ command: '/usr/local/bin/maestro', preArgs: [] });
    if (process.platform === 'win32') {
      expect(resolveMaestroSpawn('C:\\maestro\\bin\\maestro.bat')).toEqual({
        command: 'cmd.exe',
        preArgs: ['/c', 'C:\\maestro\\bin\\maestro.bat'],
      });
      expect(resolveMaestroSpawn('C:\\maestro\\bin\\maestro.CMD')).toEqual({
        command: 'cmd.exe',
        preArgs: ['/c', 'C:\\maestro\\bin\\maestro.CMD'],
      });
    }
  });
});
