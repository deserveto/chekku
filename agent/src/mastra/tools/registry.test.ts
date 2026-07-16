import { describe, expect, it } from 'vitest';

import { storedAgentTools } from './registry.js';

describe('storedAgentTools', () => {
  it('registers the tools available to stored agents', () => {
    const ids = Object.values(storedAgentTools)
      .map((tool) => tool.id)
      .sort();

    expect(ids).toEqual(['calculator', 'get-current-time', 'send-email']);
  });
});
