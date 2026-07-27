import { parsePmReportTimestamp } from '@chekku/storage';

export function escapeMarkdownTableCell(value: string): string {
  const controlCharacter = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
  const characters = Array.from(value);
  const visibleEscapes: Record<string, string> = {
    '\b': '\\b',
    '\t': '\\t',
    '\n': '\\n',
    '\v': '\\v',
    '\f': '\\f',
    '\r': '\\r',
  };

  return characters.map((character, index) => {
    const breakWww = `${character}${characters[index + 1] ?? ''}${characters[index + 2] ?? ''}${characters[index + 3] ?? ''}`
      .toLowerCase() === 'www.';
    const suffix = breakWww ? '&#8203;' : '';
    if (character === '\\') return '\\\\';
    if (character === '|') return '\\|';
    if (controlCharacter.test(character)) {
      return visibleEscapes[character]
        ?? `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
    }
    if (/[!-/:-@\[-`{-~]/.test(character)) {
      // GFM resolves backslash escapes before autolinking; hidden break keeps visible text but stops tokenization.
      return `\\${character}&#8203;`;
    }
    return `${character}${suffix}`;
  }).join('');
}

export function formatStoredCreatedAt(createdAt: string): string {
  const timestamp = parsePmReportTimestamp(createdAt);
  if (timestamp === undefined) return escapeMarkdownTableCell(createdAt);
  return `${new Date(timestamp).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
