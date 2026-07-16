import { describe, it, expect } from 'vitest';
import { mainAgent } from '../main-agent.js';
import { pmAgent } from '../pm-agent.js';
import { qaWebAgent } from '../qa-web-agent.js';

describe('main-agent (general Chekku Assistant)', () => {
  it('has id main-agent', () => {
    expect(mainAgent.id).toBe('main-agent');
  });

  it('has name Chekku Assistant', () => {
    expect(mainAgent.name).toBe('Chekku Assistant');
  });
});

describe('qa-web-agent (browser QA)', () => {
  it('has id qa-web-agent', () => {
    expect(qaWebAgent.id).toBe('qa-web-agent');
  });

  it('has name QA Web Agent', () => {
    expect(qaWebAgent.name).toBe('QA Web Agent');
  });

  it('has listBrowserTools method (browser integration present)', () => {
    expect(typeof (qaWebAgent as unknown as Record<string, unknown>).listBrowserTools).toBe('function');
  });
});

describe('pm-agent (weekly report analysis)', () => {
  it('has built-in identity, memory, and only PM report tools', async () => {
    expect(pmAgent.id).toBe('pm-agent');
    expect(pmAgent.name).toBe('PM Agent');
    expect(await pmAgent.getMemory()).toBeDefined();

    const tools = await pmAgent.listTools();
    expect(Object.keys(tools).sort()).toEqual([
      'list_pm_reports_from_garage',
      'save_pm_report_to_garage',
      'view_pm_report_from_garage',
    ]);
  });

  it('returns deterministic report list Markdown unchanged', async () => {
    const instructions = await pmAgent.getInstructions();

    expect(instructions).toContain('reportsMarkdown');
    expect(instructions).toContain('return it unchanged');
    expect(instructions).toContain('Do not reconstruct');
    expect(instructions).toContain('[<reportId>](<reportUrl>)');
  });
});

describe('agent differentiation', () => {
  it('main-agent and qa-web-agent have different ids', () => {
    expect(mainAgent.id).not.toBe(qaWebAgent.id);
  });

  it('main-agent and qa-web-agent have different names', () => {
    expect(mainAgent.name).not.toBe(qaWebAgent.name);
  });
});

it('qa-web-agent has Mastra memory for browser context', async () => {
  const memory = await qaWebAgent.getMemory();

  expect(memory).toBeDefined();
});
