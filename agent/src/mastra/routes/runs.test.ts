import { describe, expect, it } from 'vitest';
import {
  MAX_PROMPT_UTF8_BYTES,
  parseStartRunRequest,
  resolveAgent,
} from './runs.js';

const VALID = {
  agentId: 'main-agent',
  threadId: 'main-agent-user-1-uuid-a',
  resourceId: 'user-1',
  prompt: 'Hello there',
};

const agentLike = {
  stream: () => undefined,
  getMemory: async () => undefined,
};

describe('resolveAgent', () => {
  it('resolves by public agent id via getAgentById, not registry keys', () => {
    // Chekku registers agents under composition keys (mainAgent, pmAgent,
    // ...); the public id ('main-agent') lives on the agent itself. This
    // regressed once as "Unknown agent" for every agent in the UI.
    const context = {
      get: (key: string) =>
        key === 'mastra'
          ? {
              getAgentById: (id: string) =>
                id === 'main-agent' ? agentLike : undefined,
            }
          : undefined,
    };

    expect(resolveAgent(context as never, 'main-agent')).toBe(agentLike);
    expect(resolveAgent(context as never, 'no-such-agent')).toBeNull();
  });

  it('returns null when the mastra instance or agent shape is missing', () => {
    expect(resolveAgent({} as never, 'main-agent')).toBeNull();
    expect(
      resolveAgent(
        {
          get: () => ({
            getAgentById: () => ({ stream: () => undefined }),
          }),
        } as never,
        'main-agent',
      ),
    ).toBeNull();
    expect(
      resolveAgent(
        {
          get: () => ({
            getAgentById: () => {
              throw new Error('not found');
            },
          }),
        } as never,
        'main-agent',
      ),
    ).toBeNull();
  });
});

describe('parseStartRunRequest', () => {
  it('accepts a valid start payload and trims the prompt', () => {
    const result = parseStartRunRequest({ ...VALID, prompt: '  hi  ' });
    expect(result).toEqual({
      ok: true,
      value: { ...VALID, prompt: 'hi' },
    });
  });

  it('rejects non-object bodies', () => {
    expect(parseStartRunRequest(null)).toEqual({
      ok: false,
      error: 'Request body must be a JSON object',
    });
    expect(parseStartRunRequest('[]' as unknown)).toEqual({
      ok: false,
      error: 'Request body must be a JSON object',
    });
  });

  it('rejects malformed agent and resource ids', () => {
    expect(parseStartRunRequest({ ...VALID, agentId: 'MAIN' }).ok).toBe(false);
    expect(parseStartRunRequest({ ...VALID, resourceId: 'user 1' }).ok).toBe(
      false,
    );
  });

  it('rejects threads owned by another agent or resource', () => {
    const result = parseStartRunRequest({
      ...VALID,
      threadId: 'pm-agent-user-1-uuid-a',
    });
    expect(result).toEqual({
      ok: false,
      error: 'Thread does not belong to this agent and resource',
    });
  });

  it('rejects missing and oversized prompts', () => {
    expect(parseStartRunRequest({ ...VALID, prompt: '   ' }).ok).toBe(false);
    expect(parseStartRunRequest({ ...VALID, prompt: 42 as unknown }).ok).toBe(
      false,
    );

    const huge = 'x'.repeat(MAX_PROMPT_UTF8_BYTES + 1);
    expect(parseStartRunRequest({ ...VALID, prompt: huge })).toEqual({
      ok: false,
      error: 'prompt exceeds the maximum length',
    });
  });
});
