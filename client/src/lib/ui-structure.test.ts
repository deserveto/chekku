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

  it('offers only the whitelisted Garage MCP capability', () => {
    expect(agentBuilder).toContain('STUDIO_MCP_CLIENT_IDS.map');
    expect(agentBuilder).toContain(
      'Create, read, list, replace, and delete agent-isolated text objects in Garage.',
    );
    expect(agentBuilder).toContain("set('mcpClients', toggle(values.mcpClients, mcpClientId))");
    expect(agentBuilder).not.toMatch(
      /mcpUrl|mcpCommand|mcpPackage|mcpCredentials/,
    );
  });

  it('preserves Garage selection through detail hydration and model migration', () => {
    expect(storedAgents).toContain('mcpClients: readMcpClientIds(record.mcpClients)');
    expect(storedAgents).toContain('mcpClients: detail.mcpClients');
  });
});
