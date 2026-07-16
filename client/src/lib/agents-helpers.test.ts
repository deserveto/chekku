import { describe, expect, it } from 'vitest';

import {
  RESERVED_AGENT_IDS,
  agentIdIssueMessage,
  buildApiMessage,
  validateAgentId,
} from './agents-helpers';

describe('agent ID validation', () => {
  it('accepts lowercase kebab-case IDs', () => {
    expect(validateAgentId('concise-writer', new Set())).toBeNull();
  });

  it('rejects missing, malformed, reserved, and duplicate IDs', () => {
    expect(validateAgentId('   ', new Set())).toBe('required');
    expect(validateAgentId('Main_Agent', new Set())).toBe('invalid-format');
    expect(validateAgentId('UPPER', new Set())).toBe('invalid-format');
    expect(validateAgentId('-leading', new Set())).toBe('invalid-format');
    expect(validateAgentId('main-agent', new Set())).toBe('reserved');
    expect(validateAgentId('qa-web-agent', new Set())).toBe('reserved');
    expect(validateAgentId('qa-android-agent', new Set())).toBe('reserved');
    expect(validateAgentId('pm-agent', new Set())).toBe('reserved');
    expect(validateAgentId('dup', new Set(['dup']))).toBe('duplicate');
    expect(RESERVED_AGENT_IDS).toEqual(
      expect.objectContaining({
        has: expect.any(Function),
      }),
    );
  });

  it('provides a message for every validation issue', () => {
    for (const issue of [
      'required',
      'invalid-format',
      'reserved',
      'duplicate',
    ] as const) {
      expect(agentIdIssueMessage(issue)).not.toHaveLength(0);
    }
  });
});

describe('agent UI helpers', () => {
  it('surfaces API messages with useful fallbacks', () => {
    expect(buildApiMessage(409, 'Agent with id x already exists')).toBe(
      'Agent with id x already exists',
    );
    expect(buildApiMessage(409)).toBe(
      'An agent with this ID already exists.',
    );
    expect(buildApiMessage(404)).toBe(
      'Agent not found. It may have been deleted.',
    );
    expect(buildApiMessage(503)).toMatch(/unavailable/);
    expect(buildApiMessage(400, 'bad')).toBe(
      'Agent request failed (400): bad',
    );
  });
});
