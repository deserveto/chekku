import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../app/studio.css', import.meta.url), 'utf8');
const resizableSidebar = readFileSync(
  new URL('../components/studio/resizable-sidebar.tsx', import.meta.url),
  'utf8',
);
const studioNav = readFileSync(
  new URL('../components/studio/studio-nav.tsx', import.meta.url),
  'utf8',
);
const chatStudio = readFileSync(
  new URL('../components/chat/chat-studio.tsx', import.meta.url),
  'utf8',
);
const agentBuilder = readFileSync(
  new URL('../components/agents/agent-builder-page.tsx', import.meta.url),
  'utf8',
);
const storedAgents = readFileSync(
  new URL('./stored-agents.ts', import.meta.url),
  'utf8',
);
const types = readFileSync(new URL('./types.ts', import.meta.url), 'utf8');
function readOptionalSource(path: string): string {
  try {
    return readFileSync(new URL(path, import.meta.url), 'utf8');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
    return '';
  }
}
const reportListPage = readOptionalSource('../app/reports/page.tsx');
const reportDetailPage = readOptionalSource('../app/reports/[reportId]/page.tsx');

describe('requested UI structure', () => {
  it('lets each sidebar place its collapse control in the brand row', () => {
    expect(resizableSidebar).toContain('toggleCollapsed: () => void');
    expect(resizableSidebar).not.toContain('<button\n        className="studio-sidebar-collapse"');
    expect(studioNav).toContain('className="studio-brand-row"');
    expect(studioNav).toContain('className="studio-sidebar-collapse"');
    expect(chatStudio).toContain('className="studio-brand-row chat-brand-row"');
  });

  it('removes sidebar runtime and manage-agent footer clutter', () => {
    expect(studioNav).not.toContain('Runtime ready');
    expect(studioNav).not.toContain('Mastra · libSQL');
    expect(chatStudio).not.toContain('Manage agents');
    expect(chatStudio).not.toContain('Mastra Memory active');
  });

  it('renders only the revised empty-state heading', () => {
    expect(chatStudio).toContain('What should we <em>do?</em>');
    expect(chatStudio).not.toContain('Runtime ready');
    expect(chatStudio).not.toContain('Chat with a stored agent');
    expect(chatStudio).not.toContain('chat-suggestion-grid');
    expect(chatStudio).not.toContain('const suggestions');
  });

  it('keeps builder actions in normal document flow', () => {
    const rule = css.match(/\.studio-builder-footer\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    expect(rule).not.toContain('position: sticky');
    expect(rule).not.toContain('backdrop-filter');
  });
  it('offers only the whitelisted Garage and SearXNG MCP capabilities', () => {
    expect(agentBuilder).toContain('STUDIO_MCP_CLIENT_IDS.map');
    expect(agentBuilder).toMatch(
      /satisfies Record<\s*\(typeof STUDIO_MCP_CLIENT_IDS\)\[number\]/,
    );
    expect(agentBuilder).not.toContain('const MCP_META: Record<string');
    expect(agentBuilder).toContain(
      'Create, read, list, replace, and delete agent-isolated text objects in Garage.',
    );
    expect(agentBuilder).toContain(
      'Search the web through the server-owned SearXNG instance and return result snippets.',
    );
    expect(agentBuilder).toContain("set('mcpClients', toggle(values.mcpClients, mcpClientId))");
    expect(agentBuilder).not.toMatch(
      /mcpUrl|mcpCommand|mcpPackage|mcpCredentials|SEARXNG_BASE_URL|SEARXNG_API_KEY/,
    );
  });

  it('preserves Garage, SearXNG, or both selections through detail hydration and model migration', () => {
    expect(storedAgents).toContain('mcpClients: readMcpClientIds(record.mcpClients)');
    expect(storedAgents).toContain('mcpClients: detail.mcpClients');
  });

  it('links report ids to encoded detail routes with list states', () => {
    expect(reportListPage).toContain("export const dynamic = 'force-dynamic'");
    expect(reportListPage).toContain(
      'href={`/reports/${encodeURIComponent(report.reportId)}`}',
    );
    expect(reportListPage).toContain('No saved reports');
    expect(reportListPage).toContain('role="alert"');
  });

  it('keeps Garage report access server-only', () => {
    expect(reportListPage).not.toContain("'use client'");
    expect(reportDetailPage).not.toContain("'use client'");
    expect(reportListPage).toContain("from '@/server/pm-reports'");
    expect(reportDetailPage).toContain("from '@/server/pm-reports'");
    expect(reportListPage).not.toContain("from '@chekku/storage'");
    expect(reportDetailPage).not.toContain("from '@chekku/storage'");
  });

  it('reserves the PM built-in id in the shared identity set', () => {
    expect(types).toContain("export const PM_AGENT_ID = 'pm-agent'");
    expect(types).toMatch(/RESERVED_AGENT_IDS[\s\S]*PM_AGENT_ID/);
  });
});
