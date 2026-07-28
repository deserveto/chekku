import { afterEach, describe, expect, it, vi } from 'vitest';

import { listAgentSkills, __resetCache } from './agent-skills';

function mockFetch(payload: unknown, ok = true) {
  const response = { ok, json: async () => payload } as Response;
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
}

describe('listAgentSkills', () => {
  afterEach(() => {
    __resetCache();
    vi.restoreAllMocks();
  });

  it('fetches the serialized agent and reads its skills over the proxy', async () => {
    const fetchSpy = mockFetch({ skills: [{ name: 'competitive-analysis', description: 'd', 'user-invocable': true }] });
    await listAgentSkills('pm-agent');
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/agent\/api\/agents\/pm-agent(?:\?|$)/),
      expect.any(Object),
    );
  });

  it('returns user-invocable skills sorted by name', async () => {
    mockFetch({
      skills: [
        { name: 'weekly-report-analysis', description: 'w', 'user-invocable': true },
        { name: 'competitive-analysis', description: 'c', 'user-invocable': true },
        { name: 'internal-only', 'user-invocable': false },
      ],
    });
    const skills = await listAgentSkills('pm-agent');
    expect(skills.map((s) => s.name)).toEqual(['competitive-analysis', 'weekly-report-analysis']);
    expect(skills[0]).toMatchObject({ name: 'competitive-analysis', description: 'c', userInvocable: true });
  });

  it('caches per agentId and does not refetch', async () => {
    const fetchSpy = mockFetch({ skills: [{ name: 'a', 'user-invocable': true }] });
    await listAgentSkills('pm-agent');
    await listAgentSkills('pm-agent');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('refetches when agentId changes', async () => {
    const fetchSpy = mockFetch({ skills: [{ name: 'a', 'user-invocable': true }] });
    await listAgentSkills('pm-agent');
    await listAgentSkills('main-agent');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('returns [] on fetch failure without throwing', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network'));
    const skills = await listAgentSkills('pm-agent');
    expect(skills).toEqual([]);
  });

  it('handles endpoint returning a bare array', async () => {
    mockFetch([{ name: 'competitive-analysis', 'user-invocable': true }]);
    const skills = await listAgentSkills('pm-agent');
    expect(skills.map((s) => s.name)).toEqual(['competitive-analysis']);
  });
});
