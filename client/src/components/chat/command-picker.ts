export function isCommandInput(value: string): boolean {
  const trimmed = value.trimStart();
  if (!trimmed.startsWith('/')) return false;
  return !trimmed.slice(1).includes(' ');
}

export function commandFilterText(value: string): string {
  const trimmed = value.trimStart();
  return trimmed.startsWith('/') ? trimmed.slice(1) : '';
}

export type CommandKeyAction = 'next' | 'prev' | 'select' | 'close' | 'default';

export function resolveCommandKey(
  key: string,
  commandOpen: boolean,
  hasMatches: boolean,
): CommandKeyAction {
  if (!commandOpen || !hasMatches) return 'default';
  switch (key) {
    case 'ArrowDown':
      return 'next';
    case 'ArrowUp':
      return 'prev';
    case 'Enter':
    case 'Tab':
      return 'select';
    case 'Escape':
      return 'close';
    default:
      return 'default';
  }
}

export function selectSkillByIndex(
  index: number,
  names: readonly string[],
): string | null {
  if (names.length === 0) return null;
  const total = names.length;
  const wrapped = ((index % total) + total) % total;
  return names[wrapped] ?? null;
}
