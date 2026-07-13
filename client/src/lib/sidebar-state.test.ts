import { describe, expect, it } from 'vitest';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  resizeSidebarFromKey,
} from './sidebar-state';

describe('sidebar state', () => {
  it('clamps widths to supported desktop bounds', () => {
    expect(clampSidebarWidth(10)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(999)).toBe(SIDEBAR_MAX_WIDTH);
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it('resizes from keyboard commands', () => {
    expect(resizeSidebarFromKey(252, 'ArrowLeft')).toBe(236);
    expect(resizeSidebarFromKey(252, 'ArrowRight')).toBe(268);
    expect(resizeSidebarFromKey(252, 'Home')).toBe(SIDEBAR_MIN_WIDTH);
    expect(resizeSidebarFromKey(252, 'End')).toBe(SIDEBAR_MAX_WIDTH);
  });
});
