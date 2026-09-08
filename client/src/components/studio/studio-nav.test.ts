// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  act,
  createElement,
  useEffect,
  type ReactNode,
} from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  pathname: '/reports',
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock('@/lib/auth-client', () => ({
  authClient: {
    useSession: () => ({ data: { user: { email: 'owner@chekku.test' } } }),
    signOut: vi.fn(),
  },
}));
vi.mock('@/components/studio/resizable-sidebar', () => ({
  ResizableSidebar: ({ children }: {
    children: (collapsed: boolean, toggleCollapsed: () => void) => ReactNode;
  }) => children(false, () => undefined),
}));
vi.mock('@/components/ui/brand-mark', () => ({ BrandMark: () => null }));
vi.mock('@/components/settings/default-agent-field', () => ({
  readDefaultAgentId: () => null,
  clearDefaultAgentId: () => undefined,
}));
vi.mock('@/lib/stored-agents', () => ({
  listAllAgents: vi.fn(async () => []),
}));
vi.mock('@/lib/types', () => ({ MAIN_AGENT_ID: 'main-agent' }));

import {
  StudioNavigationProvider,
  useStudioNavigation,
  type NavigationGuard,
} from './studio-navigation';
import { StudioNav } from './studio-nav';

let root: Root | null = null;
function render(ui: ReactNode): HTMLElement {
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
  vi.clearAllMocks();
});
beforeEach(() => {
  mocks.pathname = '/reports';
  mocks.push.mockReset();
});

/** Registers a guard through the same provider seam the builder uses. */
function GuardRegistrar({ guard }: { guard?: NavigationGuard }) {
  const { registerGuard } = useStudioNavigation();
  useEffect(() => {
    if (!guard) return undefined;
    return registerGuard(guard);
  }, [guard, registerGuard]);
  return null;
}

function renderNav(guard?: NavigationGuard): HTMLElement {
  return render(
    createElement(
      StudioNavigationProvider,
      null,
      createElement(StudioNav, { resourceId: 'user-1' }),
      createElement(GuardRegistrar, { guard }),
    ),
  );
}

function click(element: Element): boolean {
  const event = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
  });
  element.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('StudioNav (static markup)', () => {
  function staticNav(): string {
    return renderToStaticMarkup(
      createElement(
        StudioNavigationProvider,
        null,
        createElement(StudioNav, { resourceId: 'user-1' }),
      ),
    );
  }

  it('renders accessible report navigation with current-page state', () => {
    const markup = staticNav();
    const reportLink = markup.match(/<a[^>]*href="\/reports\/weekly"[^>]*>/)?.[0];

    expect(markup).toContain('aria-label="Studio navigation"');
    expect(reportLink).toContain('aria-current="page"');
  });

  it('uses relevant shared icons for each primary destination', () => {
    const markup = staticNav();

    expect(markup.match(/class="studio-agent-icon"/g)).toHaveLength(4);
    expect(markup).not.toContain('>◫<');
    expect(markup).not.toContain('>▤<');
    expect(markup).not.toContain('>▦<');
  });

  it.each([
    '/reports/weekly',
    '/reports/pmr_20260714120000_deadbeef',
    '/reports/competitive',
    '/reports/competitive/pca_20260723120000_deadbeef',
  ])('keeps Reports active for nested route %s', (pathname) => {
    mocks.pathname = pathname;

    const markup = staticNav();
    const reportLink = markup.match(/<a[^>]*href="\/reports\/weekly"[^>]*>/)?.[0];

    expect(reportLink).toContain('class="active"');
    expect(reportLink).toContain('aria-current="page"');
  });

  it('keeps Studio navigation available in the compact mobile header', () => {
    const css = readFileSync(
      resolve(process.cwd(), 'client/src/app/studio.css'),
      'utf8',
    );
    const mobileRules = css.match(/@media \(max-width: 760px\) \{([\s\S]*)$/)?.[1] ?? '';
    const navRule = mobileRules.match(/\.studio-nav-links\s*\{([^}]*)\}/)?.[1];
    const markup = staticNav();

    expect(markup).toContain('href="/agents"');
    expect(markup).toContain('href="/reports/weekly"');
    expect(navRule).toContain('display: flex');
    expect(navRule).not.toContain('display: none');
    expect(mobileRules).toMatch(
      /\.studio-nav-links a > span:first-child\s*\{[^}]*display:\s*grid/,
    );
    expect(mobileRules).toMatch(
      /\.studio-nav-links \.studio-sidebar-copy\s*\{[^}]*display:\s*none !important/,
    );
    expect(mobileRules).not.toMatch(/\.studio-user-card\s*\{[^}]*display:\s*none/);
    expect(mobileRules).toMatch(/\.studio-account-popover\s*\{[^}]*top:\s*calc\(100% \+ 8px\)/);
  });

  it('renders the signed-in email behind an accessible account disclosure', () => {
    const markup = staticNav();

    expect(markup).toContain('owner@chekku.test');
    expect(markup).toContain('aria-label="Account menu"');
    expect(markup).not.toContain('role="menu"');
    expect(markup).not.toContain('role="menuitem"');
    expect(markup).toContain('href="/settings"');
    expect(markup).toMatch(/settings/i);
    expect(markup).toMatch(/log out|sign out/i);
  });
});

describe('StudioNav navigation guard', () => {
  it('navigates every link when no guard is registered', () => {
    const container = renderNav();

    for (const href of ['/agents', '/reports/weekly', '/social-posts', '/knowledge', '/settings']) {
      const link = container.querySelector(`a[href="${href}"]`);
      expect(link, href).not.toBeNull();
      expect(click(link!)).toBe(false);
    }
  });

  it('allows navigation when the registered guard approves', () => {
    const container = renderNav(() => true);

    expect(click(container.querySelector('a[href="/reports/weekly"]')!)).toBe(false);
    expect(click(container.querySelector('a[href="/settings"]')!)).toBe(false);
  });

  it('blocks nav links and the settings link via preventDefault when the guard rejects', () => {
    const container = renderNav(() => false);

    expect(click(container.querySelector('a[href="/reports/weekly"]')!)).toBe(true);
    expect(click(container.querySelector('a[href="/agents"]')!)).toBe(true);
    expect(click(container.querySelector('a[href="/settings"]')!)).toBe(true);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('consults the guard with the real generated chat href for New Chat', async () => {
    const seenHrefs: string[] = [];
    const container = renderNav((href) => {
      seenHrefs.push(href);
      return false;
    });

    const button = container.querySelector('.studio-primary-action');
    expect(button).not.toBeNull();
    await act(async () => {
      click(button!);
    });

    expect(seenHrefs).toHaveLength(1);
    expect(seenHrefs[0]).toMatch(
      /^\/chat\?thread=main-agent-user-1-[0-9a-f-]{36}&agent=main-agent$/,
    );
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('pushes the generated chat href when the guard approves New Chat', async () => {
    const container = renderNav(() => true);

    const button = container.querySelector('.studio-primary-action');
    await act(async () => {
      click(button!);
    });

    expect(mocks.push).toHaveBeenCalledTimes(1);
    expect(mocks.push.mock.calls[0]?.[0]).toMatch(/^\/chat\?thread=/);
  });
});
