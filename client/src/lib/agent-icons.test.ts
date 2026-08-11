import { describe, expect, it } from 'vitest';

import {
  AGENT_ICON_IDS,
  defaultAgentIcon,
  readAgentIcon,
} from './agent-icons';

describe('agent icon identity', () => {
  it('assigns distinct icons to every code-defined agent and subagent', () => {
    const ids = [
      'main-agent',
      'qa-web-agent',
      'qa-android-agent',
      'pm-agent',
      'social-media-supervisor-agent',
      'social-media-content-writer',
      'social-media-strategist-agent',
      'visual-content-agent',
    ];

    expect(new Set(ids.map(defaultAgentIcon)).size).toBe(ids.length);
  });

  it('reads only allowlisted custom icons from namespaced metadata', () => {
    expect(readAgentIcon({ chekku: { iconKey: 'compass' } }, 'custom-agent')).toBe('compass');
    expect(readAgentIcon({ chekku: { iconKey: '<script>' } }, 'custom-agent')).toBe(
      defaultAgentIcon('custom-agent'),
    );
    expect(AGENT_ICON_IDS).toContain(defaultAgentIcon('custom-agent'));
  });
});
