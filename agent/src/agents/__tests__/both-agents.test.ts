import { describe, it, expect } from 'vitest';
import { mainAgent } from '../main-agent.js';
import { pmAgent } from '../pm-agent.js';
import { qaWebAgent } from '../qa-web-agent.js';
import { qaAndroidAgent } from '../qa-android-agent.js';
import { socialMediaAgent } from '../social-media-agent.js';

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

  it('binds calculator and get-current-time tools', async () => {
    const tools = await qaWebAgent.listTools();
    expect(Object.keys(tools).sort()).toEqual([
      'calculatorTool',
      'getCurrentTimeTool',
    ]);
  });
});

describe('pm-agent (weekly and competitive analysis)', () => {
  it('has identity, memory, eight direct tools, two skills, and bounded steps', async () => {
    expect(pmAgent.id).toBe('pm-agent');
    expect(pmAgent.name).toBe('PM Agent');
    expect(await pmAgent.getMemory()).toBeDefined();

    const tools = await pmAgent.listTools();
    expect(Object.keys(tools).sort()).toEqual([
      'list_competitive_analyses_from_garage',
      'list_pm_reports_from_garage',
      'read_web_page',
      'save_competitive_analysis_to_garage',
      'save_pm_report_to_garage',
      'search_web',
      'view_competitive_analysis_from_garage',
      'view_pm_report_from_garage',
    ]);
    expect((await pmAgent.listSkills()).map(({ name }) => name).sort()).toEqual([
      'competitive-analysis',
      'weekly-report-analysis',
    ]);
    expect(await pmAgent.getDefaultOptions()).toMatchObject({ maxSteps: 18 });
    expect((await pmAgent.listConfiguredInputProcessors()).map(({ id }) => id)).toEqual([
      'token-limiter',
      'char-budget-guard',
    ]);
  });

  it('routes weekly, competitive, retrieval, and conversational intents', async () => {
    const instructions = await pmAgent.getInstructions();

    expect(instructions).toContain('/competitive-analysis');
    expect(instructions).toContain('natural-language competitive analysis');
    expect(instructions).toContain('weekly-report-analysis');
    expect(instructions).toContain('engineering weekly report');
    expect(instructions).toContain('list_competitive_analyses_from_garage');
    expect(instructions).toContain('analysesMarkdown unchanged');
    expect(instructions).toContain('view_competitive_analysis_from_garage');
    expect(instructions).toContain('pca_');
    expect(instructions).toContain('view_pm_report_from_garage');
    expect(instructions).toContain('pmr_');
    expect(instructions).toContain('Generic requests to list saved reports mean weekly reports');
    expect(instructions).toContain('reportsMarkdown unchanged');
    expect(instructions).toContain('unrelated messages conversationally');
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

describe('qa-android-agent (Maestro Android QA)', () => {
  it('has id qa-android-agent and name QA Android Agent', () => {
    expect(qaAndroidAgent.id).toBe('qa-android-agent');
    expect(qaAndroidAgent.name).toBe('QA Android Agent');
  });

  it('has Mastra memory', async () => {
    expect(await qaAndroidAgent.getMemory()).toBeDefined();
  });

  it('binds run_maestro_flow, calculator, and current-time tools', async () => {
    const tools = await qaAndroidAgent.listTools();
    expect(Object.keys(tools).sort()).toEqual(
      expect.arrayContaining(['calculatorTool', 'getCurrentTimeTool', 'run_maestro_flow']),
    );
  });
});

describe('agent differentiation (all five agents)', () => {
  it('has mutually distinct ids', () => {
    const ids = [mainAgent.id, pmAgent.id, qaWebAgent.id, qaAndroidAgent.id, socialMediaAgent.id];
    expect(new Set(ids).size).toBe(ids.length);
  });
});
