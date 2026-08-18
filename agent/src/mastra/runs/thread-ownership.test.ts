import { describe, expect, it } from 'vitest';
import {
  isAgentId,
  isOwnedThreadId,
  isResourceId,
} from './thread-ownership.js';

describe('thread ownership (agent-side mirror)', () => {
  it('accepts ids with the {agentId}-{resourceId}-{uuid} shape', () => {
    expect(
      isOwnedThreadId('main-agent-user-1-abc…uuid', 'main-agent', 'user-1'),
    ).toBe(true);
    expect(isOwnedThreadId('pm-agent-user-1-x', 'pm-agent', 'user-1')).toBe(
      true,
    );
  });

  it('rejects ids from another agent or resource', () => {
    expect(isOwnedThreadId('pm-agent-user-1-x', 'main-agent', 'user-1')).toBe(
      false,
    );
    expect(
      isOwnedThreadId('main-agent-user-2-x', 'main-agent', 'user-1'),
    ).toBe(false);
  });

  it('rejects malformed agents, resources, and empty ids', () => {
    expect(isOwnedThreadId('', 'main-agent', 'user-1')).toBe(false);
    expect(isOwnedThreadId('main-agent-user-1-x', 'MAIN-AGENT', 'user-1')).toBe(
      false,
    );
    expect(isOwnedThreadId('main-agent-user-1-x', 'main-agent', 'user 1')).toBe(
      false,
    );
    expect(isOwnedThreadId('main-agent-user-1-x', 'main agent!', 'user-1')).toBe(
      false,
    );
  });

  it('validates standalone agent and resource ids', () => {
    expect(isAgentId('qa-web-agent')).toBe(true);
    expect(isAgentId('Not An Agent')).toBe(false);
    expect(isResourceId('user-9F_')).toBe(true);
    expect(isResourceId('user 9')).toBe(false);
  });
});
