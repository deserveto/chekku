export interface AgentSkillSummary {
  name: string;
  description?: string;
  userInvocable?: boolean;
}

interface RawSkill {
  name?: unknown;
  description?: unknown;
  'user-invocable'?: unknown;
}

const cache = new Map<string, AgentSkillSummary[]>();

export function __resetCache(): void {
  cache.clear();
}

function normalize(raw: unknown): AgentSkillSummary[] {
  const list: RawSkill[] = Array.isArray(raw)
    ? (raw as RawSkill[])
    : Array.isArray((raw as { skills?: RawSkill[] })?.skills)
      ? ((raw as { skills: RawSkill[] }).skills)
      : [];
  return list
    .filter((s): s is RawSkill & { name: string } => typeof s?.name === 'string')
    .filter((s) => s['user-invocable'] !== false)
    .map((s) => ({
      name: s.name,
      ...(typeof s.description === 'string' ? { description: s.description } : {}),
      ...(s['user-invocable'] === true ? { userInvocable: true } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listAgentSkills(agentId: string): Promise<AgentSkillSummary[]> {
  const cached = cache.get(agentId);
  if (cached) return cached;
  try {
    const response = await fetch(`/api/agent/api/agents/${encodeURIComponent(agentId)}`, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      cache.set(agentId, []);
      return [];
    }
    const skills = normalize(await response.json());
    cache.set(agentId, skills);
    return skills;
  } catch {
    cache.set(agentId, []);
    return [];
  }
}
