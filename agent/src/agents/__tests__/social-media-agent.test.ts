import { describe, it, expect, beforeEach } from 'vitest';

import {
  SOCIAL_ROLES,
  getRole,
  getActiveRole,
  setActiveRole,
  resourceIdFor,
  resolveCommandResponse,
  normalizeCommandWord,
  listRolesText,
  buildInstructions,
  HELP_TEXT,
} from '../social-media-agent.js';
import { socialMediaAgent } from '../social-media-agent.js';

describe('social-media-agent (Telegram-backed social assistant)', () => {
  it('has id social-media-agent', () => {
    expect(socialMediaAgent.id).toBe('social-media-agent');
  });

  it('has name Chekku Social', () => {
    expect(socialMediaAgent.name).toBe('Chekku Social');
  });

  it('has Mastra memory for channel context', async () => {
    const memory = await socialMediaAgent.getMemory();
    expect(memory).toBeDefined();
  });

  it('binds calculator, get-current-time, and send-email tools', async () => {
    const tools = await socialMediaAgent.listTools();
    expect(Object.keys(tools).sort()).toEqual([
      'calculatorTool',
      'getCurrentTimeTool',
      'sendEmailTool',
    ]);
  });
});

describe('SOCIAL_ROLES', () => {
  it('exposes the four platform writers plus a general role', () => {
    const ids = SOCIAL_ROLES.map((r) => r.id);
    expect(ids).toEqual(['general', 'x-writer', 'instagram-writer', 'linkedin-writer', 'tiktok-writer']);
  });

  it('every role carries label, description, and guidance', () => {
    for (const role of SOCIAL_ROLES) {
      expect(role.label.trim()).not.toBe('');
      expect(role.description.trim()).not.toBe('');
      expect(role.guidance.trim()).not.toBe('');
    }
  });
});

describe('getRole', () => {
  it('returns the matching role by id', () => {
    expect(getRole('x-writer').label).toBe('X / Twitter Writer');
  });

  it('falls back to general for unknown ids', () => {
    expect(getRole('does-not-exist').id).toBe('general');
  });

  it('falls back to general for undefined', () => {
    expect(getRole(undefined).id).toBe('general');
  });
});

describe('resourceIdFor', () => {
  it('joins platform and userId', () => {
    expect(resourceIdFor('telegram', '42')).toBe('telegram:42');
  });

  it('returns undefined for empty / whitespace userIds', () => {
    expect(resourceIdFor('telegram', '')).toBeUndefined();
    expect(resourceIdFor('telegram', '   ')).toBeUndefined();
    expect(resourceIdFor('telegram', undefined)).toBeUndefined();
  });
});

describe('active role state', () => {
  beforeEach(() => {
    setActiveRole(undefined, 'general');
  });

  it('defaults to general when no role is set for a resource', () => {
    expect(getActiveRole(undefined).id).toBe('general');
    expect(getActiveRole('telegram:nobody').id).toBe('general');
  });

  it('switches per-resource and isolates resources from each other', () => {
    setActiveRole('telegram:alice', 'linkedin-writer');
    setActiveRole('telegram:bob', 'tiktok-writer');

    expect(getActiveRole('telegram:alice').id).toBe('linkedin-writer');
    expect(getActiveRole('telegram:bob').id).toBe('tiktok-writer');
    expect(getActiveRole('telegram:carol').id).toBe('general');
  });

  it('coerces unknown role ids to general', () => {
    setActiveRole('telegram:alice', 'nope');
    expect(getActiveRole('telegram:alice').id).toBe('general');
  });
});

describe('normalizeCommandWord', () => {
  it('lowercases and strips @BotName suffix used in Telegram groups', () => {
    expect(normalizeCommandWord('/Switch')).toBe('/switch');
    expect(normalizeCommandWord('/switch@ChekkuSocialBot')).toBe('/switch');
  });
});

describe('resolveCommandResponse', () => {
  const resourceId = 'telegram:alice';

  beforeEach(() => {
    // resolveCommandResponse mutates the in-memory activeRoles map; reset
    // before each case so tests don't leak role state into each other.
    setActiveRole(resourceId, 'general');
  });

  it('answers /start and /help with the help text', () => {
    expect(resolveCommandResponse('/start', '', resourceId)).toBe(HELP_TEXT);
    expect(resolveCommandResponse('/help', '', resourceId)).toBe(HELP_TEXT);
  });

  it('lists roles for /roles', () => {
    const response = resolveCommandResponse('/roles', '', resourceId);
    expect(response).toContain('Available roles:');
    expect(response).toContain('x-writer');
    expect(response).toContain('Current: general');
  });

  it('shows current role for /role without arg', () => {
    setActiveRole(resourceId, 'instagram-writer');
    const response = resolveCommandResponse('/role', '', resourceId);
    expect(response).toBe('Current role: instagram-writer — Instagram Writer');
  });

  it('switches role for /switch <known-role>', () => {
    const response = resolveCommandResponse('/switch', 'x-writer', resourceId);
    expect(response).toContain('Switched to x-writer');
    expect(getActiveRole(resourceId).id).toBe('x-writer');
  });

  it('rejects /switch with no arg', () => {
    const response = resolveCommandResponse('/switch', '', resourceId);
    expect(response).toContain('Usage: /switch <role>');
  });

  it('rejects /switch with an unknown role', () => {
    const response = resolveCommandResponse('/switch', 'mars-writer', resourceId);
    expect(response).toContain('Unknown role "mars-writer"');
    expect(getActiveRole(resourceId).id).toBe('general');
  });

  it('returns null for unknown commands so they fall through to the agent', () => {
    expect(resolveCommandResponse('/make-coffee', '', resourceId)).toBeNull();
  });
});

describe('listRolesText', () => {
  it('marks the current role with ▶', () => {
    const current = getRole('linkedin-writer');
    const text = listRolesText(current);
    expect(text).toContain('▶ linkedin-writer');
    expect(text).toContain('  general —');
    expect(text).toContain('Current: linkedin-writer');
  });
});

describe('buildInstructions', () => {
  it('embeds the active role id, label, and guidance', () => {
    const role = getRole('x-writer');
    const instructions = buildInstructions(role);
    expect(instructions).toContain('Active role: x-writer — X / Twitter Writer');
    expect(instructions).toContain(role.guidance.slice(0, 40));
  });

  it('keeps the drafting-only scope language in every role', () => {
    for (const role of SOCIAL_ROLES) {
      const instructions = buildInstructions(role);
      expect(instructions).toContain('draft and plan only');
      expect(instructions).toContain('Chekku Social');
    }
  });
});
