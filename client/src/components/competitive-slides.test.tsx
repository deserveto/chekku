// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ReactElement } from 'react';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const renderMock = vi.fn((markdown: string) => ({
  html: `<div class="marpit"><svg data-marpit-svg="" viewBox="0 0 1280 720"><foreignObject width="1280" height="720"><section id="1"><h1>RENDERED</h1><p>${markdown.slice(0, 10)}</p></section></foreignObject></svg></div>`,
  css: 'div.marpit > svg > foreignObject > section{width:1280px;height:720px}',
}));

vi.mock('@marp-team/marp-core', () => ({
  Marp: class {
    render = renderMock;
  },
}));

interface ObserverRecord {
  callback: IntersectionObserverCallback;
  instance: IntersectionObserver;
  observedSlides: Element[];
}

let observerRecords: ObserverRecord[] = [];

// jsdom lacks IntersectionObserver; component uses it for the slide counter.
globalThis.IntersectionObserver = class {
  private readonly record: ObserverRecord;

  constructor(callback: IntersectionObserverCallback) {
    this.record = {
      callback,
      instance: this as unknown as IntersectionObserver,
      observedSlides: [],
    };
    observerRecords.push(this.record);
  }
  observe(target: Element) {
    this.record.observedSlides.push(target);
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
} as unknown as typeof IntersectionObserver;

function reportVisibleSlide(index: number, observerIndex = observerRecords.length - 1): void {
  const record = observerRecords[observerIndex];
  if (!record) {
    throw new Error('IntersectionObserver was not initialized.');
  }
  const target = record.observedSlides[index];
  if (!target) throw new Error(`Slide ${index + 1} was not observed.`);
  record.callback([
    {
      target,
      isIntersecting: true,
      intersectionRatio: 1,
    } as IntersectionObserverEntry,
  ], record.instance);
}

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
  observerRecords = [];
  delete (Element.prototype as Partial<Element>).scrollIntoView;
});

describe('CompetitiveSlides', () => {
  it('renders a loading state then renders Marp output', async () => {
    const container = await render(
      <CompetitiveSlides analysisId="pca_20260723120000_deadbeef" slidesMarkdown={'---\nmarp: true\n---\n# Deck'} />,
    );

    expect(renderMock).toHaveBeenCalledWith('---\nmarp: true\n---\n# Deck');
    expect(container.innerHTML).toContain('RENDERED');
    const marpStyle = Array.from(container.querySelectorAll('style'))
      .find((s) => s.textContent?.includes('div.marpit > svg > foreignObject > section'));
    expect(marpStyle).toBeTruthy();
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

describe('CompetitiveSlides variants and chrome', () => {
  it('renders Fullscreen button in authenticated variant', async () => {
    const container = await render(
      <CompetitiveSlides
        analysisId="pca_20260723120000_deadbeef"
        slidesMarkdown={'---\nmarp: true\n---\n# Deck'}
      />,
    );
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.some((b) => b.textContent === 'Fullscreen')).toBe(true);
    expect(container.querySelector('.competitive-slides-counter')).toBeTruthy();
  });

  it('hides toolbar and shows footer in public variant', async () => {
    const container = await render(
      <CompetitiveSlides
        analysisId="pca_20260723120000_deadbeef"
        slidesMarkdown={'---\nmarp: true\n---\n# Deck'}
        variant="public"
        anchorProduct="GPT"
        createdAt="2026-07-29T10:00:00.000Z"
      />,
    );
    expect(container.querySelectorAll('button').length).toBe(0);
    expect(container.textContent).toContain('Generated by Chekku');
    expect(container.textContent).toContain('GPT');
  });

  it('requests fullscreen on Fullscreen button click', async () => {
    const requestFullscreen = vi.fn(() => Promise.resolve());
    const container = await render(
      <CompetitiveSlides
        analysisId="pca_20260723120000_deadbeef"
        slidesMarkdown={'---\nmarp: true\n---\n# Deck'}
      />,
    );
    const stage = container.querySelector('.competitive-slides-stage') as HTMLElement & {
      requestFullscreen: () => Promise<void>;
    };
    stage.requestFullscreen = requestFullscreen;
    const button = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent === 'Fullscreen') as HTMLButtonElement;
    button.click();
    expect(requestFullscreen).toHaveBeenCalledOnce();
  });

  it('advances through every slide when arrow keys repeat before observer updates', async () => {
    renderMock.mockImplementationOnce(() => ({
      html: `<div class="marpit">${Array.from({ length: 4 }, (_, index) =>
        `<svg data-marpit-svg=""><foreignObject><section id="${index + 1}"></section></foreignObject></svg>`,
      ).join('')}</div>`,
      css: '',
    }));
    const container = await render(
      <CompetitiveSlides
        analysisId="pca_20260723120000_deadbeef"
        slidesMarkdown="# Four-slide deck"
      />,
    );
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    });
    act(() => {
      reportVisibleSlide(1);
    });
    expect(container.querySelector('.competitive-slides-counter')?.textContent).toContain('3 / 4');
    act(() => {
      reportVisibleSlide(2);
      reportVisibleSlide(1);
    });
    expect(container.querySelector('.competitive-slides-counter')?.textContent).toContain('3 / 4');
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    });

    const targetIds = scrollIntoView.mock.instances.map((slide) =>
      (slide as Element).querySelector('section')?.id,
    );
    expect(targetIds).toEqual(['2', '3', '4']);
  });

  it('moves backward through every slide when left arrow repeats before observer updates', async () => {
    renderMock.mockImplementationOnce(() => ({
      html: `<div class="marpit">${Array.from({ length: 4 }, (_, index) =>
        `<svg data-marpit-svg=""><foreignObject><section id="${index + 1}"></section></foreignObject></svg>`,
      ).join('')}</div>`,
      css: '',
    }));
    const container = await render(
      <CompetitiveSlides
        analysisId="pca_20260723120000_deadbeef"
        slidesMarkdown="# Four-slide deck"
      />,
    );
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    act(() => reportVisibleSlide(3));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    });
    act(() => reportVisibleSlide(2));
    expect(container.querySelector('.competitive-slides-counter')?.textContent).toContain('2 / 4');
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    });

    const targetIds = scrollIntoView.mock.instances.map((slide) =>
      (slide as Element).querySelector('section')?.id,
    );
    expect(targetIds).toEqual(['3', '2', '1']);
  });

  it('ignores queued observer callbacks from a previous deck render', async () => {
    renderMock.mockImplementationOnce(() => ({
      html: `<div class="marpit">${Array.from({ length: 4 }, (_, index) =>
        `<svg data-marpit-svg=""><foreignObject><section id="${index + 1}"></section></foreignObject></svg>`,
      ).join('')}</div>`,
      css: '',
    }));
    const container = await render(
      <CompetitiveSlides
        analysisId="pca_20260723120000_deadbeef"
        slidesMarkdown="# Old deck"
      />,
    );
    renderMock.mockImplementationOnce(() => ({
      html: '<div class="marpit"><svg data-marpit-svg=""><foreignObject><section id="1"></section></foreignObject></svg></div>',
      css: '',
    }));

    await act(async () => {
      root!.render(
        <CompetitiveSlides
          analysisId="pca_20260723120000_deadbeef"
          slidesMarkdown="# New deck"
        />,
      );
    });
    expect(container.querySelector('.competitive-slides-counter')?.textContent).toContain('1 / 1');
    act(() => reportVisibleSlide(3, 0));

    expect(container.querySelector('.competitive-slides-counter')?.textContent).toContain('1 / 1');
  });

  it.each(['wheel', 'touchstart', 'pointerdown'])(
    'resynchronizes arrow navigation when %s interrupts a pending move',
    async (manualInputEvent) => {
      renderMock.mockImplementationOnce(() => ({
        html: `<div class="marpit">${Array.from({ length: 4 }, (_, index) =>
          `<svg data-marpit-svg=""><foreignObject><section id="${index + 1}"></section></foreignObject></svg>`,
        ).join('')}</div>`,
        css: '',
      }));
      const container = await render(
        <CompetitiveSlides
          analysisId="pca_20260723120000_deadbeef"
          slidesMarkdown="# Four-slide deck"
        />,
      );
      const scrollIntoView = vi.fn();
      Object.defineProperty(Element.prototype, 'scrollIntoView', {
        configurable: true,
        value: scrollIntoView,
      });

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
      });
      const stage = container.querySelector('.competitive-slides-stage') as HTMLElement;
      stage.dispatchEvent(new Event(manualInputEvent));
      act(() => {
        reportVisibleSlide(0);
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
      });

      const targetIds = scrollIntoView.mock.instances.map((slide) =>
        (slide as Element).querySelector('section')?.id,
      );
      expect(targetIds).toEqual(['2', '3', '2']);
    },
  );

  it('injects scoped print style that hides toolbar', async () => {
    const container = await render(
      <CompetitiveSlides
        analysisId="pca_20260723120000_deadbeef"
        slidesMarkdown={'---\nmarp: true\n---\n# Deck'}
      />,
    );
    const styles = Array.from(container.querySelectorAll('style'));
    const hasPrintRule = styles.some((s) =>
      s.textContent?.includes('@media print')
      && s.textContent?.includes('.competitive-slides-toolbar')
      && s.textContent?.includes('.competitive-slides-counter')
      && s.textContent?.includes('.public-slides-context'),
    );
    expect(hasPrintRule).toBe(true);
  });
});
