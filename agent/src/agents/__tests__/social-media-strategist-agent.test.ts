import { describe, it, expect } from 'vitest';

import { mastra } from '../../mastra/index.js';
import {
  SOCIAL_MEDIA_STRATEGIST_AGENT_ID,
  socialMediaStrategistAgent,
} from '../social-media-strategist-agent.js';
import { STRATEGY_BRIEF_TEMPLATE, CONTENT_PLAN_GUIDANCE } from '../social-media-strategist-agent.js';

const EXCLUDED_EXAMPLE_VALUES = [
  'Rafiqspace',
  'Rafiq',
  'MeetPal',
  'Agentic AI',
  'Sovereign AI',
  'Responsible AI',
  'Enterprise-Grade AI',
  'Custom AI Solutions',
  'McKinsey',
  'BCG',
  'Bain',
  'BUMN',
  'CEO / CIO / CTO',
];

describe('STRATEGY_BRIEF_TEMPLATE', () => {
  const REQUIRED_SECTIONS = [
    '# Content Strategy Brief',
    '## Objective',
    '## Target Audience',
    '## Key Topics',
    '## Product / Service Focus',
    '## Content Style',
    '## Deliverables',
    '## Success Goal',
    '## Expected Output',
  ];

  it('contains every required section heading', () => {
    for (const heading of REQUIRED_SECTIONS) {
      expect(STRATEGY_BRIEF_TEMPLATE).toContain(heading);
    }
  });

  it('uses generic placeholders, never hardcoded example values', () => {
    for (const excluded of EXCLUDED_EXAMPLE_VALUES) {
      expect(STRATEGY_BRIEF_TEMPLATE).not.toContain(excluded);
    }
  });
});

describe('CONTENT_PLAN_GUIDANCE', () => {
  it('states that the plan shape derives from the approved brief', () => {
    expect(CONTENT_PLAN_GUIDANCE).toContain('approved brief');
  });

  it('forbids hardcoded post or week counts', () => {
    expect(CONTENT_PLAN_GUIDANCE).toContain('never hardcode');
  });

  it('uses generic placeholders, never hardcoded example values', () => {
    for (const excluded of EXCLUDED_EXAMPLE_VALUES) {
      expect(CONTENT_PLAN_GUIDANCE).not.toContain(excluded);
    }
  });
});

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
    expect(ids).toEqual(['token-limiter', 'char-budget-guard']);
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

describe('social-media-strategist-agent (instructions)', () => {
  it('describes the interview → brief → review → approval → content-plan workflow', async () => {
    const instructions = await socialMediaStrategistAgent.getInstructions();

    const requiredAnchors = [
      'Social Media Strategist',
      'Content Strategy Brief',
      'Content Plan',
      'interview',
      'review',
      'approval',
      'search_web',
      'read_web_page',
      'untrusted',
    ];

    for (const anchor of requiredAnchors) {
      expect(instructions).toContain(anchor);
    }
  });

  it('keeps the strategist out of final platform-specific copy writing', async () => {
    const instructions = await socialMediaStrategistAgent.getInstructions();
    expect(instructions).toContain('strategist');
    expect((instructions as string).toLowerCase()).toContain('not the final');
  });

  it('does not hardcode any Rafiqspace-style example values', async () => {
    const instructions = await socialMediaStrategistAgent.getInstructions();
    for (const excluded of EXCLUDED_EXAMPLE_VALUES) {
      expect(instructions).not.toContain(excluded);
    }
  });
});

describe('social-media-strategist-agent (Telegram independence)', () => {
  it('does not wire any channels', () => {
    expect(socialMediaStrategistAgent.getChannels()).toBeNull();
  });

  it('does not expose a Telegram configuration flag', async () => {
    const mod = await import('../social-media-strategist-agent.js');
    expect(mod).not.toHaveProperty('isTelegramConfigured');
    expect(mod).not.toHaveProperty('registerSocialSlashCommands');
  });

  it('does not read TELEGRAM_* environment variables at module load', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile('agent/src/agents/social-media-strategist-agent.ts', 'utf8'),
    );
    expect(source).not.toMatch(/TELEGRAM_/);
    expect(source).not.toMatch(/createTelegramAdapter/);
  });
});
