import { describe, it, expect } from 'vitest';

import { mastra } from '../../mastra/index.js';
import {
  VISUAL_CONTENT_AGENT_ID,
  visualContentAgent,
} from '../visual-content-agent.js';

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
    expect(ids).toEqual(['token-limiter', 'gateway-system-message-compatibility', 'char-budget-guard']);
  });

  it('binds exactly generate_image and nothing else', async () => {
    const tools = await visualContentAgent.listTools();
    expect(Object.keys(tools).sort()).toEqual(['generateImageTool']);
  });
});

describe('visual-content-agent (instructions)', () => {
  const instructions = async () => visualContentAgent.getInstructions() as unknown as string;

  it('describes the on-demand image-generation workflow', async () => {
    const text = await instructions();
    for (const anchor of [
      'Visual Content Agent',
      'generate_image',
      'postId',
      'assetId',
      'imageUrl',
    ]) {
      expect(text).toContain(anchor);
    }
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
