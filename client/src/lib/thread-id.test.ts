import { describe, expect, it } from 'vitest';
import {
  createOwnedThreadId,
  isOwnedThreadId,
  threadPrefix,
} from './thread-id';

describe('owned thread ids', () => {
  it('prefixes ids with agent and resource ownership', () => {
    expect(
      createOwnedThreadId('main-agent', 'local-user', '0000'),
    ).toBe('main-agent-local-user-0000');
  });

  it('rejects a different agent or resource', () => {
    const id = 'qa-web-agent-local-user-123';

    expect(isOwnedThreadId(id, 'qa-web-agent', 'local-user')).toBe(true);
    expect(isOwnedThreadId(id, 'main-agent', 'local-user')).toBe(false);
    expect(isOwnedThreadId(id, 'qa-web-agent', 'other-user')).toBe(false);
  });

  it('rejects unsafe identity values', () => {
    expect(() => threadPrefix('../agent', 'local-user')).toThrow();
  });
});
