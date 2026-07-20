import { isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveAbsolutePath, resetPathCache, cacheSize } from '../paths.js';

describe('resolveAbsolutePath', () => {
  it('resolves a relative path against the base to an absolute path', () => {
    resetPathCache();
    const abs = resolveAbsolutePath('/repo/agent', '../maestro');

    expect(isAbsolute(abs)).toBe(true);
    expect(abs.includes('repo')).toBe(true);
    expect(abs.endsWith('maestro')).toBe(true);
  });

  it('returns absolute inputs unchanged in normalized form', () => {
    resetPathCache();
    const input = process.platform === 'win32' ? 'C:\\abs\\maestro' : '/abs/maestro';
    expect(resolveAbsolutePath('/anywhere', input)).toBe(input);
  });

  it('memoizes the result for the same input', () => {
    resetPathCache();
    const a = resolveAbsolutePath('/repo/agent', '../maestro');
    const b = resolveAbsolutePath('/repo/agent', '../maestro');

    expect(a).toBe(b);
    expect(cacheSize()).toBe(1);
  });
});
