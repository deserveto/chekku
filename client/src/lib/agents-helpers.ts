export const AGENT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const RESERVED_AGENT_IDS = new Set<string>([
  'main-agent',
  'qa-web-agent',
  'qa-android-agent',
  'pm-agent',
]);

export type AgentIdIssue = 'required' | 'invalid-format' | 'reserved' | 'duplicate';

export function validateAgentId(id: string, existingIds: ReadonlySet<string>): AgentIdIssue | null {
  const trimmed = id.trim();
  if (!trimmed) return 'required';
  if (!AGENT_ID_PATTERN.test(trimmed)) return 'invalid-format';
  if (RESERVED_AGENT_IDS.has(trimmed)) return 'reserved';
  if (existingIds.has(trimmed)) return 'duplicate';
  return null;
}

export function agentIdIssueMessage(issue: AgentIdIssue): string {
  switch (issue) {
    case 'required':
      return 'Agent ID is required.';
    case 'invalid-format':
      return 'Agent ID must be lowercase kebab-case (letters, digits, single hyphens).';
    case 'reserved':
      return 'Agent ID is reserved for built-in agents.';
    case 'duplicate':
      return 'An agent with this ID already exists.';
  }
}

export function buildApiMessage(status: number, serverMessage?: string): string {
  if (status === 409) return serverMessage || 'An agent with this ID already exists.';
  if (status === 404) return 'Agent not found. It may have been deleted.';
  if (status >= 500) return `The Mastra server is unavailable (${status}). Retry in a moment.`;
  const base = `Agent request failed (${status})`;
  return serverMessage ? `${base}: ${serverMessage}` : base;
}
