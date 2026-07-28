import { describe, expect, it } from 'vitest';

import {
  commandFilterText,
  isCommandInput,
  resolveCommandKey,
  selectSkillByIndex,
} from './command-picker';

describe('isCommandInput', () => {
  it('opens the picker on a bare leading slash', () => {
    expect(isCommandInput('/')).toBe(true);
  });

  it('keeps the picker open while completing the token', () => {
    expect(isCommandInput('/comp')).toBe(true);
  });

  it('keeps the picker open for the reserved catalog command', () => {
    expect(isCommandInput('/skills')).toBe(true);
  });

  it('closes the picker once applySelection adds a trailing space', () => {
    expect(isCommandInput('/competitive-analysis ')).toBe(false);
  });

  it('does not reopen the picker once arguments are present', () => {
    expect(
      isCommandInput('/competitive-analysis gpt vs claude vs gemini'),
    ).toBe(false);
  });

  it('ignores a slash that is not leading', () => {
    expect(isCommandInput('hello /x')).toBe(false);
  });

  it('trims leading whitespace before checking the slash', () => {
    expect(isCommandInput('   /x')).toBe(true);
  });

  it('returns false for empty input', () => {
    expect(isCommandInput('')).toBe(false);
  });

  it('returns false when a space splits the token', () => {
    expect(isCommandInput('/a b')).toBe(false);
  });
});

describe('commandFilterText', () => {
  it('returns the text after a leading slash', () => {
    expect(commandFilterText('/comp')).toBe('comp');
  });

  it('returns the reserved catalog token verbatim', () => {
    expect(commandFilterText('/skills')).toBe('skills');
  });

  it('returns everything after the slash even with arguments', () => {
    expect(
      commandFilterText(
        '/competitive-analysis gpt vs claude vs gemini',
      ),
    ).toBe('competitive-analysis gpt vs claude vs gemini');
  });

  it('returns empty string when input does not start with slash', () => {
    expect(commandFilterText('hello')).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(commandFilterText('')).toBe('');
  });
});

describe('resolveCommandKey', () => {
  it('returns next for ArrowDown when open with matches', () => {
    expect(resolveCommandKey('ArrowDown', true, true)).toBe('next');
  });

  it('returns prev for ArrowUp when open with matches', () => {
    expect(resolveCommandKey('ArrowUp', true, true)).toBe('prev');
  });

  it('returns select for Enter when open with matches', () => {
    expect(resolveCommandKey('Enter', true, true)).toBe('select');
  });

  it('returns select for Tab when open with matches', () => {
    expect(resolveCommandKey('Tab', true, true)).toBe('select');
  });

  it('returns close for Escape when open with matches', () => {
    expect(resolveCommandKey('Escape', true, true)).toBe('close');
  });

  it('returns default for any letter when open with matches', () => {
    expect(resolveCommandKey('a', true, true)).toBe('default');
    expect(resolveCommandKey('x', true, true)).toBe('default');
  });

  it('returns default for every key (including Enter and Tab) when closed', () => {
    expect(resolveCommandKey('Enter', false, false)).toBe('default');
    expect(resolveCommandKey('Tab', false, false)).toBe('default');
    expect(resolveCommandKey('ArrowDown', false, false)).toBe('default');
    expect(resolveCommandKey('Escape', false, false)).toBe('default');
  });

  it('returns default for every key when open but there are no matches', () => {
    expect(resolveCommandKey('Enter', true, false)).toBe('default');
    expect(resolveCommandKey('Tab', true, false)).toBe('default');
    expect(resolveCommandKey('ArrowDown', true, false)).toBe('default');
    expect(resolveCommandKey('ArrowUp', true, false)).toBe('default');
  });
});

describe('selectSkillByIndex', () => {
  const names = ['competitive-analysis', 'weekly-report-analysis', 'social-draft'] as const;

  it('returns null for an empty name list', () => {
    expect(selectSkillByIndex(0, [])).toBeNull();
  });

  it('returns the name at a zero-based positive index', () => {
    expect(selectSkillByIndex(0, names)).toBe('competitive-analysis');
    expect(selectSkillByIndex(1, names)).toBe('weekly-report-analysis');
    expect(selectSkillByIndex(2, names)).toBe('social-draft');
  });

  it('wraps a negative index to the end of the list', () => {
    expect(selectSkillByIndex(-1, names)).toBe('social-draft');
    expect(selectSkillByIndex(-2, names)).toBe('weekly-report-analysis');
  });

  it('wraps an out-of-range positive index back into the list', () => {
    expect(selectSkillByIndex(3, names)).toBe('competitive-analysis');
    expect(selectSkillByIndex(5, names)).toBe('social-draft');
  });
});
