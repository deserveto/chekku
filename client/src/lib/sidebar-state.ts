export const SIDEBAR_COLLAPSED_WIDTH = 72;
export const SIDEBAR_DEFAULT_WIDTH = 252;
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 360;
export const SIDEBAR_KEYBOARD_STEP = 16;

export function clampSidebarWidth(value: number): number {
  if (!Number.isFinite(value)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(value)));
}

export function resizeSidebarFromKey(current: number, key: string): number {
  switch (key) {
    case 'ArrowLeft':
      return clampSidebarWidth(current - SIDEBAR_KEYBOARD_STEP);
    case 'ArrowRight':
      return clampSidebarWidth(current + SIDEBAR_KEYBOARD_STEP);
    case 'Home':
      return SIDEBAR_MIN_WIDTH;
    case 'End':
      return SIDEBAR_MAX_WIDTH;
    default:
      return clampSidebarWidth(current);
  }
}
