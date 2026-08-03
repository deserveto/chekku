import { readFileSync } from 'node:fs';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

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
    signOut: vi.fn(async () => ({ success: true })),
  },
}));
vi.mock('@/components/studio/resizable-sidebar', () => ({
  ResizableSidebar: ({ children }: {
    children: (collapsed: boolean, toggleCollapsed: () => void) => ReactNode;
  }) => children(false, () => undefined),
}));
vi.mock('@/components/ui/brand-mark', () => ({ BrandMark: () => null }));
vi.mock('@/lib/chat-route', () => ({ buildChatHref: () => '/chat/test' }));
vi.mock('@/lib/thread-id', () => ({ createOwnedThreadId: () => 'thread-id' }));
vi.mock('@/lib/types', () => ({ MAIN_AGENT_ID: 'main-agent' }));

import { StudioNav } from './studio-nav';

beforeEach(() => {
  mocks.pathname = '/reports';
  mocks.push.mockClear();
});

it('renders accessible report navigation with current-page state', () => {
  const markup = renderToStaticMarkup(createElement(StudioNav, { resourceId: 'user-1' }));
  const reportLink = markup.match(/<a[^>]*href="\/reports"[^>]*>/)?.[0];

  expect(markup).toContain('aria-label="Studio navigation"');
  expect(reportLink).toContain('aria-current="page"');
});

it.each([
  '/reports/weekly',
  '/reports/pmr_20260714120000_deadbeef',
  '/reports/competitive',
  '/reports/competitive/pca_20260723120000_deadbeef',
])('keeps Reports active for nested route %s', (pathname) => {
  mocks.pathname = pathname;

  const markup = renderToStaticMarkup(createElement(StudioNav, { resourceId: 'user-1' }));
  const reportLink = markup.match(/<a[^>]*href="\/reports"[^>]*>/)?.[0];

  expect(reportLink).toContain('class="active"');
  expect(reportLink).toContain('aria-current="page"');
});

it('keeps Studio navigation available in the compact mobile header', () => {
  const css = readFileSync(new URL('../../app/studio.css', import.meta.url), 'utf8');
  const mobileRules = css.match(/@media \(max-width: 760px\) \{([\s\S]*)$/)?.[1] ?? '';
  const navRule = mobileRules.match(/\.studio-nav-links\s*\{([^}]*)\}/)?.[1];
  const markup = renderToStaticMarkup(createElement(StudioNav, { resourceId: 'user-1' }));

  expect(markup).toContain('href="/agents"');
  expect(markup).toContain('href="/reports"');
  expect(navRule).toContain('display: flex');
  expect(navRule).not.toContain('display: none');
});

it('renders the signed-in email and a logout control', () => {
  const markup = renderToStaticMarkup(createElement(StudioNav, { resourceId: 'user-1' }));

  expect(markup).toContain('owner@chekku.test');
  expect(markup).toMatch(/log out|sign out/i);
});
