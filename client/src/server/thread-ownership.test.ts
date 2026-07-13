import { describe, expect, it } from 'vitest';
import { assertOwnedThread, threadPrefix } from './thread-ownership';

describe('thread ownership', () => {
  it('builds the controlled owner prefix', () => {
    expect(threadPrefix('demo-agent', 'local-user')).toBe('demo-agent-local-user-');
  });

  it('accepts an owned thread', () => {
    expect(assertOwnedThread('demo-agent', 'local-user', 'demo-agent-local-user-abc')).toBeUndefined();
  });

  it('rejects a foreign thread', () => {
    expect(() => assertOwnedThread('demo-agent', 'local-user', 'demo-agent-other-abc'))
      .toThrow('FORBIDDEN');
  });
});
