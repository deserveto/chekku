'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { AgentIcon } from '@/components/agents/agent-icon';
import { CommandPalette } from '@/components/studio/command-palette';
import { ResizableSidebar } from '@/components/studio/resizable-sidebar';
import { BrandMark } from '@/components/ui/brand-mark';
import {
  clearDefaultAgentId,
  readDefaultAgentId,
} from '@/components/settings/default-agent-field';
import { authClient } from '@/lib/auth-client';
import { buildChatHref } from '@/lib/chat-route';
import { listAllAgents } from '@/lib/stored-agents';
import { createOwnedThreadId } from '@/lib/thread-id';
import { MAIN_AGENT_ID } from '@/lib/types';

export function StudioNav({ resourceId }: { resourceId: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session } = authClient.useSession();
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  const accountTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!accountOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!accountRef.current?.contains(event.target as Node)) {
        setAccountOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setAccountOpen(false);
        accountTriggerRef.current?.focus();
      }
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [accountOpen]);

  const [creatingChat, setCreatingChat] = useState(false);

  const startChat = async () => {
    setCreatingChat(true);
    try {
      let agentId = MAIN_AGENT_ID;
      const preferred = readDefaultAgentId();
      if (preferred) {
        const agents = await listAllAgents().catch(() => []);
        if (agents.some((agent) => agent.id === preferred)) {
          agentId = preferred;
        } else {
          clearDefaultAgentId();
        }
      }
      const threadId = createOwnedThreadId(agentId, resourceId);
      router.push(buildChatHref(agentId, threadId));
    } finally {
      setCreatingChat(false);
    }
  };

  const signOut = async () => {
    setAccountOpen(false);
    await authClient.signOut();
    router.push('/login');
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
            onClick={() => void startChat()}
            disabled={creatingChat}
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
              <span aria-hidden="true"><AgentIcon icon="network" /></span>
              <span className="studio-sidebar-copy">Agents</span>
            </Link>
            <Link
              href="/reports/weekly"
              className={pathname.startsWith('/reports') ? 'active' : ''}
              aria-current={pathname.startsWith('/reports') ? 'page' : undefined}
              aria-label="Reports"
              title={collapsed ? 'Reports' : undefined}
            >
              <span aria-hidden="true"><AgentIcon icon="chart" /></span>
              <span className="studio-sidebar-copy">Reports</span>
            </Link>
            <Link
              href="/social-posts"
              className={pathname.startsWith('/social-posts') ? 'active' : ''}
              aria-current={pathname.startsWith('/social-posts') ? 'page' : undefined}
              aria-label="Social posts"
              title={collapsed ? 'Social posts' : undefined}
            >
              <span aria-hidden="true"><AgentIcon icon="pen" /></span>
              <span className="studio-sidebar-copy">Social posts</span>
            </Link>
            <Link
              href="/knowledge"
              className={pathname.startsWith('/knowledge') ? 'active' : ''}
              aria-current={pathname.startsWith('/knowledge') ? 'page' : undefined}
              aria-label="Knowledge"
              title={collapsed ? 'Knowledge' : undefined}
            >
              <span aria-hidden="true"><AgentIcon icon="book" /></span>
              <span className="studio-sidebar-copy">Knowledge</span>
            </Link>
          </nav>

          <div className="studio-nav-spacer" />

          {session?.user?.email ? (
            <div className="studio-account" ref={accountRef}>
              <button
                type="button"
                ref={accountTriggerRef}
                className="studio-user-card"
                onClick={() => setAccountOpen((open) => !open)}
                aria-expanded={accountOpen}
                aria-controls="studio-account-menu"
                aria-label="Account menu"
                title={collapsed ? 'Account menu' : undefined}
              >
                <span className="studio-user-avatar" aria-hidden="true">
                  {session.user.email.charAt(0).toUpperCase()}
                </span>
                <span className="studio-user-copy studio-sidebar-copy">
                  <strong>{session.user.email}</strong>
                  <small>Personal workspace</small>
                </span>
                <span className="studio-account-chevron studio-sidebar-copy" aria-hidden="true">⌃</span>
              </button>
              <div
                id="studio-account-menu"
                className="studio-account-popover"
                hidden={!accountOpen}
              >
                <div className="studio-account-summary">
                  <span className="studio-user-avatar" aria-hidden="true">
                    {session.user.email.charAt(0).toUpperCase()}
                  </span>
                  <span>
                    <strong>Signed in</strong>
                    <small>{session.user.email}</small>
                  </span>
                </div>
                <Link href="/settings" onClick={() => setAccountOpen(false)}>
                  <span aria-hidden="true">⚙</span>
                  Settings
                </Link>
                <button type="button" onClick={signOut}>
                  <span aria-hidden="true">↗</span>
                  Sign out
                </button>
              </div>
            </div>
          ) : null}
          <CommandPalette resourceId={resourceId} />
        </>
      )}
    </ResizableSidebar>
  );
}
