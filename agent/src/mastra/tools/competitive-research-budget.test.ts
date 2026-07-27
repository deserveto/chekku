import { describe, expect, it } from 'vitest';

import { withCompetitiveResearchBudget } from './competitive-research-budget.js';

function makeTool(execute: (input: unknown, ctx: unknown) => Promise<unknown>) {
  return { id: 'x', description: 'x', execute } as unknown as Record<string, unknown>;
}

function execOf(tool: unknown): (input: unknown, ctx: unknown) => Promise<unknown> {
  return (tool as { execute: (i: unknown, c: unknown) => Promise<unknown> }).execute;
}

function ctx(threadId: string) {
  return { agent: { agentId: 'pm-agent', threadId } };
}

describe('withCompetitiveResearchBudget', () => {
  it('rejects the sixth search_web call per run', async () => {
    let calls = 0;
    const tool = withCompetitiveResearchBudget('search_web', makeTool(async () => { calls++; return { ok: true }; }));
    for (let i = 0; i < 5; i++) {
      await execOf(tool)({}, ctx('cap-search'));
    }
    expect(calls).toBe(5);
    await expect(execOf(tool)({}, ctx('cap-search'))).rejects.toThrow(/budget exhausted/);
    expect(calls).toBe(5);
  });

  it('counts failed attempts toward the limit', async () => {
    const tool = withCompetitiveResearchBudget('search_web', makeTool(async () => { throw new Error('boom'); }));
    for (let i = 0; i < 5; i++) {
      await expect(execOf(tool)({}, ctx('cap-fail'))).rejects.toThrow('boom');
    }
    await expect(execOf(tool)({}, ctx('cap-fail'))).rejects.toThrow(/budget exhausted/);
  });

  it('stops read_web_page after terminal configuration error', async () => {
    let calls = 0;
    const tool = withCompetitiveResearchBudget('read_web_page', makeTool(async () => {
      calls++;
      throw new Error('Web Reader is not configured.');
    }));
    await expect(execOf(tool)({}, ctx('cap-term'))).rejects.toThrow('Web Reader is not configured.');
    expect(calls).toBe(1);
    await expect(execOf(tool)({}, ctx('cap-term'))).rejects.toThrow('Web Reader is not configured.');
    expect(calls).toBe(1);
  });

  it('allows non-terminal reader failures to continue up to the cap', async () => {
    const tool = withCompetitiveResearchBudget('read_web_page', makeTool(async () => {
      throw new Error('Web Reader is unavailable. Try again later.');
    }));
    for (let i = 0; i < 8; i++) {
      await expect(execOf(tool)({}, ctx('cap-nonterm'))).rejects.toThrow('unavailable');
    }
    await expect(execOf(tool)({}, ctx('cap-nonterm'))).rejects.toThrow(/budget exhausted/);
  });

  it('allows only one save per run', async () => {
    let calls = 0;
    const tool = withCompetitiveResearchBudget('save_competitive_analysis_to_garage', makeTool(async () => { calls++; return { analysisId: 'pca_1' }; }));
    await execOf(tool)({}, ctx('cap-save'));
    await expect(execOf(tool)({}, ctx('cap-save'))).rejects.toThrow(/already been saved/);
    expect(calls).toBe(1);
  });

  it('does not consume the save slot when a save attempt fails', async () => {
    let calls = 0;
    let attempt = 0;
    const tool = withCompetitiveResearchBudget(
      'save_competitive_analysis_to_garage',
      makeTool(async () => {
        calls += 1;
        attempt += 1;
        if (attempt === 1) throw new Error('validation failed');
        return { analysisId: 'pca_2' };
      }),
    );
    await expect(execOf(tool)({}, ctx('save-retry'))).rejects.toThrow('validation failed');
    const result = await execOf(tool)({}, ctx('save-retry'));
    expect(result).toEqual({ analysisId: 'pca_2' });
    expect(calls).toBe(2);
    await expect(execOf(tool)({}, ctx('save-retry'))).rejects.toThrow(/already been saved/);
  });

  it('isolates budgets by thread', async () => {
    let calls = 0;
    const tool = withCompetitiveResearchBudget('search_web', makeTool(async () => { calls++; return { ok: true }; }));
    for (let i = 0; i < 5; i++) await execOf(tool)({}, ctx('iso-A'));
    await expect(execOf(tool)({}, ctx('iso-A'))).rejects.toThrow(/budget exhausted/);
    await execOf(tool)({}, ctx('iso-B'));
    expect(calls).toBeGreaterThanOrEqual(6);
  });

  it('passes through when agent run context is absent', async () => {
    let calls = 0;
    const tool = withCompetitiveResearchBudget('search_web', makeTool(async () => { calls++; return { ok: true }; }));
    for (let i = 0; i < 10; i++) await execOf(tool)({}, {});
    expect(calls).toBe(10);
  });
});
