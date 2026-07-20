'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ResizableSidebar } from '@/components/studio/resizable-sidebar';
import { BrandMark } from '@/components/ui/brand-mark';
import { buildChatHref } from '@/lib/chat-route';
import { createOwnedThreadId } from '@/lib/thread-id';
import { MAIN_AGENT_ID } from '@/lib/types';

export function StudioNav({ resourceId }: { resourceId: string }) {
  const pathname = usePathname();
  const router = useRouter();

  const startChat = () => {
    const threadId = createOwnedThreadId(MAIN_AGENT_ID, resourceId);
    router.push(buildChatHref(MAIN_AGENT_ID, threadId));
  };

  return (
    <ResizableSidebar
      id="studio-navigation"
      className="studio-nav"
      storageKey="chekku-studio-sidebar"
      label="Studio sidebar"
    >
      {(collapsed, toggleCollapsed) => (
        <>
          <div className="studio-brand-row">
            <Link
              className="studio-brand"
              href="/agents"
              aria-label="Chekku Agent Studio"
              title={collapsed ? 'Chekku Agent Studio' : undefined}
            >
              <BrandMark />
              <span className="studio-sidebar-copy">
                <strong>Chekku</strong>
                <small>Agent Studio</small>
              </span>
            </Link>
            <button
              className="studio-sidebar-collapse"
              type="button"
              onClick={toggleCollapsed}
              aria-controls="studio-navigation"
              aria-expanded={!collapsed}
              aria-label={collapsed ? 'Expand Studio sidebar' : 'Collapse Studio sidebar'}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {collapsed ? '›' : '‹'}
            </button>
          </div>

          <button
            className="studio-primary-action"
            type="button"
            onClick={startChat}
            aria-label="New chat"
            title={collapsed ? 'New chat' : undefined}
          >
            <span aria-hidden="true">＋</span>
            <span className="studio-sidebar-copy">New chat</span>
          </button>

          <nav className="studio-nav-links" aria-label="Studio navigation">
            <Link
              href="/agents"
              className={pathname.startsWith('/agents') ? 'active' : ''}
              aria-current={pathname.startsWith('/agents') ? 'page' : undefined}
              aria-label="Agents"
              title={collapsed ? 'Agents' : undefined}
            >
              <span aria-hidden="true">◫</span>
              <span className="studio-sidebar-copy">Agents</span>
            </Link>
            <Link
              href="/reports"
              className={pathname.startsWith('/reports') ? 'active' : ''}
              aria-current={pathname.startsWith('/reports') ? 'page' : undefined}
              aria-label="Reports"
              title={collapsed ? 'Reports' : undefined}
            >
              <span aria-hidden="true">▤</span>
              <span className="studio-sidebar-copy">Reports</span>
            </Link>
            <Link
              href="/social-posts"
              className={pathname.startsWith('/social-posts') ? 'active' : ''}
              aria-current={pathname.startsWith('/social-posts') ? 'page' : undefined}
              aria-label="Social posts"
              title={collapsed ? 'Social posts' : undefined}
            >
              <span aria-hidden="true">▦</span>
              <span className="studio-sidebar-copy">Social posts</span>
            </Link>
          </nav>

          <div className="studio-nav-spacer" />
        </>
      )}
    </ResizableSidebar>
  );
}
