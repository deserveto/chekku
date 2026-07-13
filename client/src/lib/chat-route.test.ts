import { describe, expect, it } from 'vitest';
import {
  buildChatHref,
  normalizeAgentId,
  resolveChatIdentity,
} from './chat-route';

describe('chat route', () => {
  it('builds a stable static chat URL', () => {
    expect(
      buildChatHref(
        'qa-web-agent',
        'qa-web-agent-local-user-123',
      ),
    ).toBe(
      '/chat?thread=qa-web-agent-local-user-123&agent=qa-web-agent',
    );
  });

  it('generates a canonical owned thread when query is missing', () => {
    expect(resolveChatIdentity({}, 'local-user', 'fixed-uuid')).toEqual({
      agentId: 'main-agent',
      threadId: 'main-agent-local-user-fixed-uuid',
      canonicalHref:
        '/chat?thread=main-agent-local-user-fixed-uuid&agent=main-agent',
      generated: true,
    });
  });

  it('keeps an owned thread and normalizes invalid agent ids', () => {
    expect(
      resolveChatIdentity(
        {
          agent: 'qa-web-agent',
          thread: 'qa-web-agent-local-user-123',
        },
        'local-user',
      ).generated,
    ).toBe(false);

    expect(normalizeAgentId('../unsafe')).toBe('main-agent');
  });
});
