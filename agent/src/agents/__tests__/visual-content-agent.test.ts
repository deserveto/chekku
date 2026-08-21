import { describe, it, expect } from 'vitest';

import { mastra } from '../../mastra/index.js';
import {
  VISUAL_CONTENT_AGENT_ID,
  buildInstructions,
  visualContentAgent,
} from '../visual-content-agent.js';

describe('visual-content-agent (instructions env gating)', () => {
  it('production instructions contain no preview_image mention', () => {
    const text = buildInstructions('production');
    expect(text).not.toContain('preview_image');
    expect(text).not.toContain('previewId');
    expect(text).not.toContain('Gambar preview');
    // The production delegation rule, workflow, and worked example steer only
    // toward the registered post-bound tool.
    expect(text).toContain('Use generate_image with postId <id>');
    expect(text).toContain('smp_20260817120000_a1b2c3d4');
  });

  it('non-production instructions keep the dev-only preview_image guidance', () => {
    const text = buildInstructions('development');
    expect(text).toContain('Use preview_image (no postId)');
    expect(text).toContain('Gambar preview sudah jadi');
    expect(text).toContain('## Ad-hoc chat visuals (no post)');
  });
});

describe('visual-content-agent (registration and identity)', () => {
  it('exposes the stable agent id constant', () => {
    expect(VISUAL_CONTENT_AGENT_ID).toBe('visual-content-agent');
  });

  it('has id visual-content-agent', () => {
    expect(visualContentAgent.id).toBe('visual-content-agent');
  });

  it('has name Visual Content Agent', () => {
    expect(visualContentAgent.name).toBe('Visual Content Agent');
  });

  it('is registered in the Mastra agents map as a top-level agent', () => {
    const agents = mastra.listAgents();
    expect(Object.keys(agents)).toContain('visualContentAgent');
    expect(agents.visualContentAgent).toBe(visualContentAgent);
  });
});

describe('visual-content-agent (memory, context protection, tools)', () => {
  it('has Mastra memory configured', async () => {
    const memory = await visualContentAgent.getMemory();
    expect(memory).toBeDefined();
  });

  it('binds the context limiter, gateway compatibility, and char-budget guard in the correct order', async () => {
    const processors = await visualContentAgent.listConfiguredInputProcessors();
    const ids = processors
      .map((p) => (p as { id?: unknown })?.id)
      .filter((id): id is string => typeof id === 'string');
    // Mastra prepends the TaskStateProcessor from the task signal provider;
    // the agent-configured order keeps the char-budget guard last, with the
    // task nudge before it.
    expect(ids).toEqual(['task-state', 'token-limiter', 'gateway-system-message-compatibility', 'task-nudge', 'char-budget-guard']);
  });

  it('binds generate_image, review_image, plus the dev-only preview_image', async () => {
    const tools = await visualContentAgent.listTools();
    // Vitest runs with NODE_ENV='test' (non-production), so the dev-only
    // post-less `previewImageTool` is registered alongside `generateImageTool`
    // and its companion `reviewImageTool`. In production only
    // `generateImageTool` and `reviewImageTool` are registered. Task tools
    // arrive through `signals: createTaskSignals()`.
    expect(Object.keys(tools).sort()).toEqual([
      'generateImageTool',
      'previewImageTool',
      'reviewImageTool',
      'task_check',
      'task_complete',
      'task_update',
      'task_write',
    ]);
  });
});

describe('visual-content-agent (instructions)', () => {
  const instructions = async () => visualContentAgent.getInstructions() as unknown as string;

  it('describes the on-demand image-generation workflow', async () => {
    const text = await instructions();
    for (const anchor of [
      'Visual Content Agent',
      'generate_image',
      'review_image',
      'postId',
      'assetId',
      'imageUrl',
    ]) {
      expect(text).toContain(anchor);
    }
  });

  it('documents the self-review loop with the regeneration cap', async () => {
    const text = await instructions();
    expect(text.toLowerCase()).toContain('self-review loop');
    expect(text.toLowerCase()).toContain('score');
    expect(text.toLowerCase()).toContain('cap');
  });

  it('declares the renderer-only contract', async () => {
    const text = await instructions();
    expect(text.toLowerCase()).toContain('renderer');
    expect(text.toLowerCase()).toContain('not a researcher');
    expect(text.toLowerCase()).toContain('not a fact-checker');
    expect(text.toLowerCase()).toContain('not an editorial decision-maker');
  });

  it('forbids adding new facts, statistics, names, or quotes in the visual', async () => {
    const text = await instructions();
    expect(text).toContain('You are forbidden from');
    expect(text.toLowerCase()).toContain('adding a number');
    expect(text.toLowerCase()).toContain('organization name');
    expect(text.toLowerCase()).toContain('strengthening a headline');
  });

  it('forbids inverting attribution and the assessment-to-endorsement upgrade', async () => {
    const text = await instructions();
    expect(text.toLowerCase()).toContain('inverting');
    expect(text).toContain('Indonesia menilai kesiapan AI');
    expect(text).toContain('Indonesia Siap AI');
  });

  it('documents the source-attribution rule with the verified-only constraint', async () => {
    const text = await instructions();
    expect(text).toContain('Source attribution rule');
    expect(text).toContain('Sumber: <sourceName>');
    expect(text.toLowerCase()).toContain('unverified');
    expect(text.toLowerCase()).toContain('invent a publisher name');
  });

  it('exports the RAFIQSPACE_BRAND constant with the wordmark and asset path', async () => {
    const mod = await import('../visual-content-agent.js') as {
      RAFIQSPACE_BRAND: { brandName: string; wordmark: string; assetPath: string };
    };
    expect(mod.RAFIQSPACE_BRAND.brandName).toBe('Rafiqspace AI');
    expect(mod.RAFIQSPACE_BRAND.wordmark).toBe('Rafiqspace AI');
    expect(mod.RAFIQSPACE_BRAND.assetPath).toBe('agent/src/assets/image.png');
  });

  it('documents the pillar-aware visual identity for all three pillars', async () => {
    const text = await instructions();
    expect(text).toContain('Pillar-aware visual identity');
    expect(text).toContain('PILLAR A — CELEBRATION / HARI BESAR');
    expect(text).toContain('PILLAR B — TECHNOLOGY & AI');
    expect(text).toContain('PILLAR C — GENERAL / DIGITAL SOCIETY');
    // Palette anchors per pillar
    expect(text).toContain('cream, gold accent');
    expect(text).toContain('deep navy, cyan accent');
    expect(text).toContain('slate, blue accent');
  });

  it('forbids mixing celebration and cyberpunk-tech styles', async () => {
    const text = await instructions();
    expect(text).toContain('NEVER request cyberpunk');
  });

  it('documents the structured VisualBrief split', async () => {
    const text = await instructions();
    expect(text).toContain('VisualBrief');
    expect(text.toLowerCase()).toContain('pure-visual');
    expect(text).toContain('NEVER request text overlays, headlines, numbers, dates, statistics');
    expect(text).toContain('application compositor owns every textual element and the real logo asset');
  });

  it('documents the pure-visual construction with structured fields', async () => {
    const text = await instructions();
    expect(text).toContain('Pure-visual');
    expect(text).toContain('heroSubject');
    expect(text).toContain('artDirection');
    expect(text).toContain('lighting');
    expect(text).toContain('composition');
    expect(text).toContain('decorativeElements');
    expect(text).toContain('cameraDirection');
    expect(text).toContain('visualIdentity');
  });

  it('forbids asking the image model for text, logos, headlines, numbers', async () => {
    const text = await instructions();
    expect(text).toContain('no text, no typography, no logos');
    expect(text.toLowerCase()).toContain('never request text overlays');
    expect(text.toLowerCase()).toContain('never include the words "rafiqspace"');
  });

  it('documents the headline rule with strengthening-forbidden examples', async () => {
    const text = await instructions();
    expect(text).toContain('Headline rule');
    expect(text).toContain('170.000 GPU di Batam');
    expect(text).toContain('FORBIDDEN: "170.000 GPU di Batam: Pusat Compute AI Baru Asia Pasifik"');
  });

  it('documents the facts rule with the strengthening-forbidden mapping', async () => {
    const text = await instructions();
    expect(text).toContain('Facts rule');
    expect(text).toContain('using Nvidia tech');
    expect(text).toContain('Nvidia-owned');
  });

  it('documents the brand-mark logo handling (compositor stamps real PNG, agent does not draw it)', async () => {
    const text = await instructions();
    expect(text).toContain('Brand-mark / logo handling');
    // The agent MUST be told the compositor owns the logo, and the agent does not draw/render it.
    expect(text.toLowerCase()).toContain('compositor');
    expect(text.toLowerCase()).toContain('you do not draw it');
    // The agent MUST be told not to speculate about the asset — this prevents the
    // smaller orchestration model from inventing "logo file not found" failures
    // without ever calling the tool.
    expect(text.toLowerCase()).toContain('do not speculate');
  });

  it('places the logo per pillar (top-left for celebration, bottom-right for tech/general)', async () => {
    const text = await instructions();
    // Per-pillar placement: celebration = top-left, technology/general = bottom-right.
    expect(text.match(/top-left/gi)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(text.match(/bottom-right/gi)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(text).toContain('CELEBRATION');
    expect(text).toContain('TECHNOLOGY');
    expect(text).toContain('GENERAL');
  });

  it('requires approved content and forbids automatic generation', async () => {
    const text = await instructions();
    expect(text).toContain('APPROVED');
    expect(text.toLowerCase()).toContain('on-demand');
    expect(text.toLowerCase()).toContain('never generate automatically');
  });

  it('forbids publishing', async () => {
    const text = await instructions();
    expect(text.toLowerCase()).toContain('do not publish');
  });

  it('defines a revision as a regeneration, never an edit', async () => {
    const text = await instructions();
    expect(text.toLowerCase()).toContain('revision is a regeneration');
    expect(text.toLowerCase()).toContain('never describe a revision as editing');
  });

  it('documents the hero number rule (LEVEL 1 visual hook)', async () => {
    const text = await instructions();
    expect(text).toContain('Hero number rule');
    expect(text).toContain('heroNumber');
    // Must be copied verbatim from verified facts — never invented or strengthened.
    expect(text.toLowerCase()).toContain('never invented');
    expect(text.toLowerCase()).toContain('target');
    // Must be omitted when canonical has no decisive number — layout adapts.
    expect(text.toLowerCase()).toContain('omit');
  });

  it('forbids cyberpunk / sci-fi / neon-noir aesthetics for TECHNOLOGY content', async () => {
    const text = await instructions();
    expect(text.toLowerCase()).toContain('cyberpunk');
    expect(text.toLowerCase()).toContain('no cyberpunk');
    expect(text.toLowerCase()).toContain('no sci-fi');
    expect(text.toLowerCase()).toContain('no excessive neon');
  });

  it('forbids inventing or estimating source dates', async () => {
    const text = await instructions();
    expect(text).toContain('Source attribution rule');
    expect(text.toLowerCase()).toContain('never invent a date');
    expect(text.toLowerCase()).toContain('never estimate a date');
  });

  it('reserves negative space at the top of the background for typography overlay', async () => {
    const text = await instructions();
    expect(text.toLowerCase()).toContain('intentional negative space');
  });
});

describe('visual-content-agent (Telegram and Garage MCP independence)', () => {
  it('does not wire any channels', () => {
    expect(visualContentAgent.getChannels()).toBeNull();
  });

  it('does not expose a Telegram configuration flag', async () => {
    const mod = await import('../visual-content-agent.js');
    expect(mod).not.toHaveProperty('isTelegramConfigured');
    expect(mod).not.toHaveProperty('registerSocialSlashCommands');
  });

  it('does not reference TELEGRAM_ or a generic Garage MCP dependency in source', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile('agent/src/agents/visual-content-agent.ts', 'utf8'),
    );
    expect(source).not.toMatch(/TELEGRAM_/);
    expect(source).not.toMatch(/createTelegramAdapter/);
    expect(source).not.toMatch(/garageMcpServer/);
  });
});
