import { describe, expect, it } from 'vitest';

import {
  COMPETITIVE_RESEARCH_TERMINAL_INSTRUCTION,
  createCompetitiveResearchGuard,
  getCompetitiveResearchDecision,
} from './competitive-research-guard.js';

const tools = [
  'search_web',
  'read_web_page',
  'save_competitive_analysis_to_garage',
  'list_competitive_analyses_from_garage',
];

function msg(role: string, parts: unknown[]) {
  return { role, content: { format: 2, parts } };
}

const toolInvocation = (toolName: string, result?: unknown) => ({
  type: 'tool-invocation',
  toolInvocation: { state: 'result', toolCallId: `call-${toolName}`, toolName, args: {}, result },
});

const readerErrorInvocation = (category: string, message: string) => ({
  type: 'tool-invocation',
  toolInvocation: {
    state: 'result',
    toolCallId: 'call-reader',
    toolName: 'read_web_page',
    args: {},
    result: { name: 'Error', cause: { category, message } },
  },
});

describe('competitive research guard', () => {
  it('removes search after eight attempts and preserves unrelated tools', () => {
    const messages = [
      msg('assistant', [toolInvocation('search_web')]),
      msg('assistant', [toolInvocation('search_web')]),
      msg('assistant', [toolInvocation('search_web')]),
      msg('assistant', [toolInvocation('search_web')]),
      msg('assistant', [toolInvocation('search_web')]),
      msg('assistant', [toolInvocation('search_web')]),
      msg('assistant', [toolInvocation('search_web')]),
      msg('assistant', [toolInvocation('search_web')]),
    ];

    const decision = getCompetitiveResearchDecision(messages, tools);

    expect(decision.activeTools).not.toContain('search_web');
    expect(decision.activeTools).toContain('list_competitive_analyses_from_garage');
  });

  it('removes Reader after fourteen attempts including failures', () => {
    const messages: unknown[] = [];
    for (let i = 0; i < 13; i++) {
      messages.push(msg('assistant', [toolInvocation('read_web_page')]));
    }
    messages.push(msg('assistant', [readerErrorInvocation('unavailable', 'Web Reader is unavailable. Try again later.')]));

    const decision = getCompetitiveResearchDecision(messages as never, tools);

    expect(decision.activeTools).not.toContain('read_web_page');
    expect(decision.terminalConfigurationFailure).toBe(false);
  });

  it('does not remove save (budget wrapper owns save enforcement and counts only successful saves)', () => {
    const messages = [msg('assistant', [toolInvocation('save_competitive_analysis_to_garage')])];

    const decision = getCompetitiveResearchDecision(messages, tools);

    expect(decision.activeTools).toContain('save_competitive_analysis_to_garage');
  });

  it('stops Reader immediately after terminal configuration failure', () => {
    const messages = [msg('assistant', [readerErrorInvocation('configuration', 'Web Reader is not configured.')])];

    const decision = getCompetitiveResearchDecision(messages, tools);

    expect(decision.activeTools).not.toContain('read_web_page');
    expect(decision.terminalConfigurationFailure).toBe(true);
  });

  it('keeps Reader after a nonterminal failure while slots remain', () => {
    const messages = [msg('assistant', [readerErrorInvocation('unavailable', 'Web Reader is unavailable. Try again later.')])];

    const decision = getCompetitiveResearchDecision(messages, tools);

    expect(decision.activeTools).toContain('read_web_page');
    expect(decision.terminalConfigurationFailure).toBe(false);
  });

  it('injects only fixed safe terminal guidance', async () => {
    const processor = createCompetitiveResearchGuard();
    const result = await processor.processInputStep?.({
      messages: [msg('assistant', [readerErrorInvocation('configuration', 'Web Reader is not configured.')])] as never,
      tools: Object.fromEntries(tools.map((tool) => [tool, {}])),
      systemMessages: [],
    } as never) as { activeTools: string[]; systemMessages: Array<{ content: string }> };

    expect(processor.id).toBe('competitive-research-guard');
    expect(result.activeTools).not.toContain('read_web_page');
    expect(result.systemMessages.at(-1)?.content).toBe(COMPETITIVE_RESEARCH_TERMINAL_INSTRUCTION);
    expect(COMPETITIVE_RESEARCH_TERMINAL_INSTRUCTION).toBe(
      'Web Reader configuration failed for this run. Do not call read_web_page again. Return the incomplete competitive-analysis branch using only successful page evidence from this run. Do not save it and do not emit Saved analysisId:.',
    );
  });

  it('detects terminal config failure when reader result is a plain string', () => {
    const stringError = (message: string) => ({
      type: 'tool-invocation',
      toolInvocation: { state: 'result', toolCallId: 'call-r', toolName: 'read_web_page', args: {}, result: message },
    });
    const messages = [msg('assistant', [stringError('Web Reader is not configured.')])];
    const decision = getCompetitiveResearchDecision(messages, tools);
    expect(decision.terminalConfigurationFailure).toBe(true);
    expect(decision.activeTools).not.toContain('read_web_page');
  });

  it('handles content as a plain string without parts', () => {
    const messages = [{ role: 'user', content: 'hello' }];
    const decision = getCompetitiveResearchDecision(messages, tools);
    expect(decision.activeTools).toEqual(tools);
    expect(decision.terminalConfigurationFailure).toBe(false);
  });

  it('scopes counts to the current run (after the most recent user role)', () => {
    const priorRun = [
      msg('user', [{ type: 'text', text: 'first competitive analysis' }]),
      msg('assistant', [toolInvocation('search_web')]),
      msg('assistant', [toolInvocation('search_web')]),
      msg('assistant', [toolInvocation('search_web')]),
      msg('assistant', [toolInvocation('search_web')]),
      msg('assistant', [toolInvocation('search_web')]),
    ];
    const currentRun = [
      msg('user', [{ type: 'text', text: 'second competitive analysis' }]),
      msg('assistant', [toolInvocation('search_web')]),
      msg('assistant', [toolInvocation('search_web')]),
    ];
    const decision = getCompetitiveResearchDecision([...priorRun, ...currentRun], tools);

    expect(decision.activeTools).toContain('search_web');
  });

  it('scopes terminal reader configuration failure to the current run', () => {
    const priorRun = [
      msg('user', [{ type: 'text', text: 'first competitive analysis' }]),
      msg('assistant', [readerErrorInvocation('configuration', 'Web Reader is not configured.')]),
    ];
    const currentRun = [
      msg('user', [{ type: 'text', text: 'second competitive analysis' }]),
    ];
    const decision = getCompetitiveResearchDecision([...priorRun, ...currentRun], tools);

    expect(decision.terminalConfigurationFailure).toBe(false);
    expect(decision.activeTools).toContain('read_web_page');
  });
});
