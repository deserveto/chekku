// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ReactElement } from 'react';

import { CommandMenu } from './command-menu';

const skills = [
  { name: 'competitive-analysis', description: 'Research products' },
  { name: 'weekly-report-analysis', description: 'Weekly risk' },
];

let root: Root | null = null;
function render(ui: ReactElement): HTMLDivElement {
  document.body.innerHTML = '';
  const container = document.createElement('div');
  document.body.appendChild(container);
  const r = createRoot(container);
  root = r;
  act(() => {
    r.render(ui);
  });
  return container;
}
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  document.body.innerHTML = '';
  root = null;
});

describe('CommandMenu', () => {
  it('renders one row per supplied skill and no reserved catalog row', () => {
    const container = render(<CommandMenu commands={skills} activeIndex={0} onSelect={() => {}} />);
    expect(container.textContent).toContain('/competitive-analysis');
    expect(container.textContent).toContain('/weekly-report-analysis');
    expect(container.textContent).not.toContain('/skills');
    expect(container.querySelectorAll('[role="option"]').length).toBe(skills.length);
  });

  it('marks the active option with aria-selected and points aria-activedescendant at it', () => {
    const container = render(<CommandMenu commands={skills} activeIndex={1} onSelect={() => {}} />);
    const listbox = container.querySelector('[role="listbox"]') as HTMLElement;
    expect(listbox.getAttribute('aria-activedescendant')).toBe('cmd-weekly-report-analysis');
    const options = container.querySelectorAll('[role="option"]');
    expect(options[1]?.getAttribute('aria-selected')).toBe('true');
    expect(options[0]?.getAttribute('aria-selected')).toBe('false');
  });

  it('calls onSelect with the skill name', () => {
    const onSelect = vi.fn();
    const container = render(<CommandMenu commands={skills} activeIndex={0} onSelect={onSelect} />);
    (container.querySelector('#cmd-competitive-analysis') as HTMLButtonElement).click();
    expect(onSelect).toHaveBeenCalledWith('competitive-analysis');
  });

  it('renders a Skill type label on every option row', () => {
    const container = render(<CommandMenu commands={skills} activeIndex={0} onSelect={() => {}} />);
    const typeLabels = container.querySelectorAll('.chat-command-menu__type');
    expect(typeLabels.length).toBe(skills.length);
    typeLabels.forEach((node) => {
      expect(node.textContent).toBe('Skill');
    });
  });

  it('renders no options when the command list is empty', () => {
    const container = render(<CommandMenu commands={[]} activeIndex={0} onSelect={() => {}} />);
    expect(container.querySelectorAll('[role="option"]').length).toBe(0);
    expect(container.textContent).not.toContain('/skills');
  });
});
