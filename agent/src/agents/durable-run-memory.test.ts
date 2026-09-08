import { describe, expect, it } from 'vitest';

import { createDurableRunMemoryOptions } from './durable-run-memory.js';

describe('createDurableRunMemoryOptions', () => {
  it('derives a canonical-shape thread under the reserved delegation resource', () => {
    const options = createDurableRunMemoryOptions('visual-content-agent');
    expect(options.memory.resource).toBe('delegation');
    expect(options.memory.thread).toMatch(
      /^visual-content-agent-delegation-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('produces a fresh thread per call', () => {
    const a = createDurableRunMemoryOptions('visual-content-agent');
    const b = createDurableRunMemoryOptions('visual-content-agent');
    expect(a.memory.thread).not.toBe(b.memory.thread);
  });
});
