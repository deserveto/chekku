import { describe, it, expect } from 'vitest';

import { mastra } from '../../mastra/index.js';
import {
  SOCIAL_MEDIA_STRATEGIST_AGENT_ID,
  socialMediaStrategistAgent,
} from '../social-media-strategist-agent.js';
import { STRATEGY_BRIEF_TEMPLATE, CONTENT_PLAN_GUIDANCE } from '../social-media-strategist-agent.js';

// Brand-brief sections must remain brand-agnostic. The brand-brief template
// (`STRATEGY_BRIEF_TEMPLATE`), the Content Plan guidance, and the brand-brief
// workflow instructions must not hardcode any specific customer brand.
// Note: "Rafiqspace" and "Agentic AI" are intentionally NOT on this list —
// "Rafiqspace AI" IS the brand this agent serves in news-research mode (the
// editorial identity block legitimately references it), and "Agentic AI" is a
// real industry term used by the TECHNOLOGY & AI pillar's sub-angle taxonomy,
// not a placeholder brand example. The brand-brief-mode template is still
// verified brand-agnostic by the STRATEGY_BRIEF_TEMPLATE test below (it
// checks the exported constant directly, not the full instructions string).
const EXCLUDED_EXAMPLE_VALUES = [
  'MeetPal',
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
    // Mastra prepends the TaskStateProcessor from the task signal provider;
    // the agent-configured order keeps the char-budget guard last, with the
    // task nudge before it.
    expect(ids).toEqual(['task-state', 'token-limiter', 'task-nudge', 'char-budget-guard']);
  });

  it('exposes search_web and read_web_page', async () => {
    const tools = await socialMediaStrategistAgent.listTools();
    const keys = Object.keys(tools);
    expect(keys).toEqual(expect.arrayContaining(['search_web', 'read_web_page']));
  });

  it('binds exactly the two research tools plus task tracking and nothing else', async () => {
    const tools = await socialMediaStrategistAgent.listTools();
    expect(Object.keys(tools).sort()).toEqual([
      'read_web_page',
      'search_web',
      'task_check',
      'task_complete',
      'task_update',
      'task_write',
    ]);
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

describe('social-media-strategist-agent (news-research mode)', () => {
  const instructions = async () => socialMediaStrategistAgent.getInstructions() as unknown as string;

  it('documents the news-research contract section with News Research Result output format', async () => {
    const text = await instructions();
    expect(text).toContain('News Research Result');
    expect(text).toContain('### [Source N]');
    expect(text).toContain('Verified facts:');
    expect(text).toContain('Editorial interpretation');
    expect(text).toContain('Confidence:');
  });

  it('lists the recency vocabulary triggers', async () => {
    const text = await instructions();
    for (const trigger of ['terbaru', 'terkini', 'saat ini', 'minggu ini', 'viral', 'trending', 'latest', 'current']) {
      expect(text).toContain(trigger);
    }
  });

  it('requires timeRange to be set when recency vocabulary is present', async () => {
    const text = await instructions();
    expect(text).toContain('timeRange');
    expect(text).toContain("'day'");
    expect(text).toContain("'month'");
  });

  it('forbids presenting results without publishedAt as recency-verified', async () => {
    const text = await instructions();
    expect(text.toLowerCase()).toContain('not recency-verified');
  });

  it('forbids aggregator dashboards and bare domains as the source URL', async () => {
    const text = await instructions();
    expect(text).toContain('Google News');
    expect(text).toContain('aggregator');
    expect(text.toLowerCase()).toContain('bare domain');
  });

  it('forbids fabricated URLs', async () => {
    const text = await instructions();
    expect(text.toLowerCase()).toContain('fabricated');
    expect(text.toLowerCase()).toContain('do not invent');
  });

  it('lists recognized Indonesian and international publishers for credibility preference', async () => {
    const text = await instructions();
    expect(text).toContain('Kompas');
    expect(text).toContain('Reuters');
    expect(text).toContain('Antaranews');
  });

  it('forbids strengthening claims with the assessment-vs-endorsement mapping', async () => {
    const text = await instructions();
    expect(text.toLowerCase()).toContain('menilai kesiapan');
    expect(text.toLowerCase()).toContain('endorsement');
  });

  it('requires graceful failure when a source cannot be verified', async () => {
    const text = await instructions();
    expect(text.toLowerCase()).toContain('unverifiable');
    expect(text).toContain('tidak menemukan artikel yang dapat diverifikasi');
  });

  it('updates the description to advertise the news-research mode', () => {
    expect(socialMediaStrategistAgent.getDescription()).toContain('News-research mode');
    expect(socialMediaStrategistAgent.getDescription()).toContain('Brand-strategy mode');
  });
});

describe('social-media-strategist-agent (Rafiqspace editorial identity + pillar classification)', () => {
  const instructions = async () => socialMediaStrategistAgent.getInstructions() as unknown as string;

  it('documents the Rafiqspace editorial identity and the Human × Technology × Indonesia thread', async () => {
    const text = await instructions();
    expect(text).toContain('Rafiqspace editorial identity');
    expect(text).toContain('Human × Technology × Indonesia');
    expect(text).toContain('Rafiqspace AI is NOT a generic AI news aggregator');
  });

  it('documents the NEWS → UNDERSTANDING → WHY IT MATTERS → RAFIQSPACE PERSPECTIVE lens', async () => {
    const text = await instructions();
    expect(text).toContain('NEWS');
    expect(text).toContain('UNDERSTANDING');
    expect(text).toContain('WHY IT MATTERS');
    expect(text).toContain('RAFIQSPACE PERSPECTIVE');
  });

  it('lists the seven Rafiqspace perspective questions', async () => {
    const text = await instructions();
    expect(text).toContain('What is actually happening?');
    expect(text).toContain('Why does this matter?');
    expect(text).toContain('What is the connection to Indonesia?');
    expect(text).toContain('What is the impact on humans?');
  });

  it('defines the three content pillars with their tones and examples', async () => {
    const text = await instructions();
    expect(text).toContain('PILLAR A — CELEBRATION / HARI BESAR');
    expect(text).toContain('PILLAR B — TECHNOLOGY & AI TRENDS');
    expect(text).toContain('PILLAR C — GENERAL / DIGITAL SOCIETY TRENDS');
    expect(text).toContain('warm, respectful, elegant');
    expect(text).toContain('informative, intelligent, modern, concise');
    expect(text).toContain('accessible, contemporary, reflective');
  });

  it('requires contentPillar in the News Research Result output', async () => {
    const text = await instructions();
    expect(text).toContain('Content pillar: CELEBRATION | TECHNOLOGY | GENERAL');
  });

  it('lists the six technology sub-angles', async () => {
    const text = await instructions();
    expect(text).toContain('AI Infrastructure');
    expect(text).toContain('AI Agents / Agentic AI');
    expect(text).toContain('AI × Indonesia');
    expect(text).toContain('AI Explained');
    expect(text).toContain('Future of Work');
    expect(text).toContain('AI Myth / Reality');
  });

  it('documents the general-trend relevance filter (skip if not tech/digital/human-behaviour)', async () => {
    const text = await instructions();
    expect(text).toContain('General trend filter');
    expect(text).toContain('Is this relevant to technology / digital life / human behavior?');
    expect(text).toContain('Can Rafiqspace add meaningful perspective?');
  });
});

describe('social-media-strategist-agent (extended research contract)', () => {
  const instructions = async () => socialMediaStrategistAgent.getInstructions() as unknown as string;

  it('requires editorialAngles (2-6 candidates, with RECOMMENDED marker)', async () => {
    const text = await instructions();
    expect(text).toContain('Multiple editorial angles');
    expect(text).toContain('2–6 candidate editorial angles');
    expect(text).toContain('RECOMMENDED');
  });

  it('requires contextualCaveats that MUST propagate downstream', async () => {
    const text = await instructions();
    expect(text).toContain('Contextual caveats');
    expect(text).toContain('MUST propagate downstream');
    expect(text).toContain('Firmus adalah developer');
  });

  it('documents the published-date absolute-extraction flow', async () => {
    const text = await instructions();
    expect(text).toContain('Published-date extraction');
    expect(text).toContain('2 days ago');
    expect(text).toContain('absolute publication date');
    expect(text).toContain('ISO');
  });

  it('expands the anti-strengthening mapping with planned/completed and announced/launched', async () => {
    const text = await instructions();
    expect(text).toContain('planned');
    expect(text).toContain('completed');
    expect(text).toContain('announced');
    expect(text).toContain('launched');
    expect(text).toContain('menggunakan teknologi Nvidia');
    expect(text).toContain('milik Nvidia');
  });

  it('includes the discoveredAt field in the output contract', async () => {
    const text = await instructions();
    expect(text).toContain('Discovered: <today\'s ISO date>');
  });

  it('routes celebration content through the News Research Result with shifted research focus', async () => {
    const text = await instructions();
    expect(text).toContain('The user asks for celebration / hari besar content');
    expect(text).toContain('Content pillar: CELEBRATION');
    expect(text).toContain('makna hari');
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
