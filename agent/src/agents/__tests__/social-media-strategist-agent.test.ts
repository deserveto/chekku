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

describe('social-media-strategist-agent (memory, context protection, tools)', () => {
  it('has Mastra memory configured', async () => {
    const memory = await socialMediaStrategistAgent.getMemory();
    expect(memory).toBeDefined();
  });

  it('binds the context limiter and char-budget guard input processors', async () => {
    const processors = await socialMediaStrategistAgent.listConfiguredInputProcessors();
    const ids = processors.map((p) => (p as { id?: unknown })?.id).filter((id): id is string => typeof id === 'string');
    expect(ids).toEqual(expect.arrayContaining(['token-limiter', 'char-budget-guard']));
  });

  it('exposes search_web and read_web_page', async () => {
    const tools = await socialMediaStrategistAgent.listTools();
    const keys = Object.keys(tools);
    expect(keys).toEqual(expect.arrayContaining(['search_web', 'read_web_page']));
  });

  it('binds exactly the two research tools and nothing else', async () => {
    const tools = await socialMediaStrategistAgent.listTools();
    expect(Object.keys(tools).sort()).toEqual(['read_web_page', 'search_web']);
  });
});
