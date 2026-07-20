import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { loadMaestroMcpTools, __resetMaestroCache } from '../qa-android-agent.js';
import { env } from '../../config/env.js';

describe('loadMaestroMcpTools (Maestro MCP failure caching regression)', () => {
  const originalEnabled = env.MAESTRO_ENABLED;

  beforeEach(() => {
    __resetMaestroCache();
  });

  afterEach(() => {
    env.MAESTRO_ENABLED = originalEnabled;
    vi.restoreAllMocks();
  });

  it('returns empty tools and caches the failure when the MCP client throws', async () => {
    env.MAESTRO_ENABLED = 'true';
    const createClient = vi.fn(() => ({
      listTools: () => Promise.reject(new Error('boom')),
    }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const first = await loadMaestroMcpTools({ createClient });
    expect(first).toEqual({});
    expect(Object.keys(first)).toHaveLength(0);

    const second = await loadMaestroMcpTools({ createClient });
    expect(second).toEqual({});
    expect(createClient).toHaveBeenCalledTimes(1);

    expect(errorSpy).toHaveBeenCalled();
    const logged = String(errorSpy.mock.calls[0][0]);
    expect(logged).toContain('[qa-android-agent]');
    expect(logged).toContain('boom');
  });

  it('returns empty tools without invoking the client when MAESTRO_ENABLED is not \'true\'', async () => {
    env.MAESTRO_ENABLED = 'false';
    const createClient = vi.fn(() => {
      throw new Error('factory must not be called');
    });

    const result = await loadMaestroMcpTools({ createClient });
    expect(result).toEqual({});
    expect(createClient).not.toHaveBeenCalled();
  });
});
