// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ReactElement } from 'react';

import { ShareLinkButton } from './share-link-button';

let root: Root | null = null;
function render(ui: ReactElement): HTMLDivElement {
  document.body.innerHTML = '';
  const container = document.createElement('div');
  document.body.appendChild(container);
  const r = createRoot(container);
  root = r;
  act(() => { r.render(ui); });
  return container;
}
afterEach(() => {
  act(() => { root?.unmount(); });
  document.body.innerHTML = '';
  root = null;
  vi.restoreAllMocks();
});

describe('ShareLinkButton', () => {
  it('renders Create share link initially', () => {
    const container = render(<ShareLinkButton analysisId="pca_20260723120000_deadbeef" />);
    expect(container.querySelector('button')?.textContent).toContain('Create share link');
  });

  it('renders Copy share link when the analysis is already shared', () => {
    const container = render(
      <ShareLinkButton analysisId="pca_20260723120000_deadbeef" initiallyShared />,
    );
    expect(container.querySelector('button')?.textContent).toContain('Copy share link');
  });

  it('retrieves and copies the existing URL on the first copy click', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ url: '/public/slides/pca_x?t=existing' }),
    } as Response);
    const container = render(
      <ShareLinkButton analysisId="pca_20260723120000_deadbeef" initiallyShared />,
    );

    await act(async () => {
      (container.querySelector('button') as HTMLButtonElement).click();
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(
      `${window.location.origin}/public/slides/pca_x?t=existing`,
    );
  });

  it('creates share link on click and updates label to Copy share link', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ url: '/public/slides/pca_x?t=abc' }),
    } as Response);

    const container = render(<ShareLinkButton analysisId="pca_20260723120000_deadbeef" />);
    const button = container.querySelector('button') as HTMLButtonElement;

    await act(async () => { button.click(); });

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/storage/competitive-analyses/pca_20260723120000_deadbeef/share',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/public/slides/pca_x?t=abc`);
    expect(container.querySelector('button')?.textContent).toContain('Copy share link');
  });

  it('disables creation while the request is pending and sends only one POST', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => new Promise<Response>(() => {}),
    );
    const container = render(<ShareLinkButton analysisId="pca_20260723120000_deadbeef" />);
    const button = container.querySelector('button') as HTMLButtonElement;

    act(() => {
      button.click();
      button.click();
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(button.disabled).toBe(true);
  });

  it('renders error message on fetch failure', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      json: async () => ({ error: { code: 'not-found', message: 'Analysis missing.' } }),
    } as Response);

    const container = render(<ShareLinkButton analysisId="pca_20260723120000_deadbeef" />);
    const button = container.querySelector('button') as HTMLButtonElement;

    await act(async () => { button.click(); });

    expect(fetchSpy).toHaveBeenCalled();
    expect(container.textContent).toContain('Could not create share link');
  });
});
