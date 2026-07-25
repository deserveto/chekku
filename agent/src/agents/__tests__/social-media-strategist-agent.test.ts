import { describe, it, expect } from 'vitest';

import { mastra } from '../../mastra/index.js';
import {
  SOCIAL_MEDIA_STRATEGIST_AGENT_ID,
  socialMediaStrategistAgent,
} from '../social-media-strategist-agent.js';

describe('social-media-strategist-agent (registration and identity)', () => {
  it('exposes the stable agent id constant', () => {
    expect(SOCIAL_MEDIA_STRATEGIST_AGENT_ID).toBe('social-media-strategist-agent');
  });

  it('has id social-media-strategist-agent', () => {
    expect(socialMediaStrategistAgent.id).toBe('social-media-strategist-agent');
  });

  it('has name Social Media Strategist', () => {
    expect(socialMediaStrategistAgent.name).toBe('Social Media Strategist');
  });

  it('is registered in the Mastra agents map', () => {
    const agents = mastra.listAgents();
    expect(Object.keys(agents)).toContain('socialMediaStrategistAgent');
    expect(agents.socialMediaStrategistAgent).toBe(socialMediaStrategistAgent);
  });
});
