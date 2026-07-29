// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ReactElement } from 'react';

const renderMock = vi.fn((markdown: string) => ({
  html: `<div class="marpit"><svg data-marpit-svg="" viewBox="0 0 1280 720"><foreignObject width="1280" height="720"><section id="1"><h1>RENDERED</h1><p>${markdown.slice(0, 10)}</p></section></foreignObject></svg></div>`,
  css: 'div.marpit > svg > foreignObject > section{width:1280px;height:720px}',
}));

vi.mock('@marp-team/marp-core', () => ({
  Marp: class {
    render = renderMock;
  },
}));

import { CompetitiveSlides } from './competitive-slides';

let root: Root | null = null;
async function render(ui: ReactElement): Promise<HTMLDivElement> {
  document.body.innerHTML = '';
  const container = document.createElement('div');
  document.body.appendChild(container);
  const r = createRoot(container);
  root = r;
  await act(async () => {
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
  renderMock.mockClear();
});

describe('CompetitiveSlides', () => {
  it('renders a loading state then renders Marp output', async () => {
    const container = await render(
      <CompetitiveSlides analysisId="pca_20260723120000_deadbeef" slidesMarkdown={'---\nmarp: true\n---\n# Deck'} />,
    );

    expect(renderMock).toHaveBeenCalledWith('---\nmarp: true\n---\n# Deck');
    expect(container.innerHTML).toContain('RENDERED');
    expect(container.querySelector('style')?.textContent).toContain('div.marpit > svg > foreignObject > section');
  });

  it('renders a Print button that triggers window.print', async () => {
    const container = await render(
      <CompetitiveSlides analysisId="pca_20260723120000_deadbeef" slidesMarkdown="# Deck" />,
    );
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => { });

    const printButton = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent === 'Print');
    expect(printButton).toBeTruthy();
    printButton!.click();
    expect(printSpy).toHaveBeenCalledOnce();
    printSpy.mockRestore();
  });

  it('renders a fixed safe error when Marp render throws', async () => {
    renderMock.mockImplementationOnce(() => { throw new Error('boom'); });
    const container = await render(
      <CompetitiveSlides analysisId="pca_20260723120000_deadbeef" slidesMarkdown="# Deck" />,
    );

    expect(container.textContent).toContain('Could not render slides.');
    expect(container.innerHTML).toContain('/reports/competitive/pca_20260723120000_deadbeef');
  });
});
