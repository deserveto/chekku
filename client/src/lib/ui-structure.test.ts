import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../app/studio.css', import.meta.url), 'utf8');
const resizableSidebar = readFileSync(
  new URL('../components/studio/resizable-sidebar.tsx', import.meta.url),
  'utf8',
);
const brandMark = readFileSync(
  new URL('../components/ui/brand-mark.tsx', import.meta.url),
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
const agentCatalogSource = readFileSync(
  new URL('../components/agents/agent-catalog-page.tsx', import.meta.url),
  'utf8',
);
const confirmationDialog = readOptionalSource(
  '../components/ui/confirmation-dialog.tsx',
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
function readStudioSource(path: string): string {
  return (
    readOptionalSource(path) ||
    readOptionalSource(path.replace('../app/', '../app/(studio)/'))
  );
}
const reportLandingPage = readStudioSource('../app/reports/page.tsx');
const reportListPage = readStudioSource('../app/reports/weekly/page.tsx');
const reportDetailPage = readStudioSource('../app/reports/[reportId]/page.tsx');
const reportTabs = readFileSync(
  new URL('../components/reports/report-tabs.tsx', import.meta.url),
  'utf8',
);
const competitiveAnalysisListPage = readStudioSource('../app/reports/competitive/page.tsx');
const competitiveAnalysisDetailPage = readStudioSource('../app/reports/competitive/[analysisId]/page.tsx');
const competitiveAnalysisSlidesPage = readOptionalSource('../app/reports/competitive/[analysisId]/slides/page.tsx') || readOptionalSource('../app/(studio)/reports/competitive/[analysisId]/slides/page.tsx');
const publicSlidesPage = readOptionalSource('../app/public/slides/[analysisId]/page.tsx');

describe('requested UI structure', () => {
  it('lets each sidebar place its collapse control in the brand row', () => {
    expect(resizableSidebar).toContain('toggleCollapsed: () => void');
    expect(resizableSidebar).not.toContain('<button\n        className="studio-sidebar-collapse"');
    expect(studioNav).toContain('className="studio-brand-row"');
    expect(studioNav).toContain('className="studio-sidebar-collapse"');
    expect(chatStudio).toContain('className="studio-brand-row chat-brand-row"');
  });

  it('reveals the collapsed expand control only from the logo hover or focus target', () => {
    expect(css).toMatch(
      /\.is-collapsed \.studio-sidebar-collapse\s*\{[^}]*opacity:\s*0/s,
    );
    expect(css).toMatch(
      /\.is-collapsed \.studio-brand-row:hover \.studio-sidebar-collapse[\s\S]*opacity:\s*1/,
    );
    expect(css).toMatch(
      /\.is-collapsed \.studio-brand-row:focus-within \.studio-sidebar-collapse[\s\S]*opacity:\s*1/,
    );
    expect(css).toMatch(
      /\.is-collapsed \.studio-brand-row:hover \.studio-brand-mark[\s\S]*opacity:\s*0/,
    );
  });

  it('keeps the collapsed sidebar control available on touch-only desktop layouts', () => {
    expect(css).toMatch(
      /@media \(hover: none\) and \(min-width: 761px\)[\s\S]*?\.is-collapsed \.studio-sidebar-collapse\s*\{[^}]*opacity:\s*1[^}]*pointer-events:\s*auto/s,
    );
  });

  it('suppresses the sidebar width transition until stored preferences are applied', () => {
    // The (studio) layout now persists the sidebar across routes, but the
    // first paint still suppresses width and descendant transitions until
    // localStorage state lands.
    expect(resizableSidebar).toContain("ready ? 'is-ready' : ''");
    const gate = css.match(
      /\.studio-resizable-sidebar:not\(\.is-ready\)[^{]*\{([^}]*)\}/,
    )?.[1];
    expect(gate).toContain('transition: none');
  });

  it('centers the collapsed expand control within the sidebar', () => {
    const rule = css.match(
      /\.studio-resizable-sidebar\.is-collapsed \.studio-brand-row\s*\{([^}]*)\}/,
    )?.[1];
    expect(rule).toContain('margin-inline: auto');
  });

  it('renders the Chekku mark from the docs logo geometry', () => {
    const docsLogo = readFileSync(
      new URL('../../../docs/chekku-logo.svg', import.meta.url),
      'utf8',
    );
    const docsPaths = [...docsLogo.matchAll(/ d="([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(docsPaths.length).toBeGreaterThan(0);
    for (const path of docsPaths) {
      expect(brandMark).toContain(path);
    }
  });

  it('uses the docs logo as the app favicon instead of the framework template', () => {
    const iconPath = new URL('../app/icon.svg', import.meta.url);
    expect(existsSync(iconPath)).toBe(true);
    expect(readFileSync(iconPath, 'utf8')).toContain(
      'M5 8.5 16 3l11 5.5v15L16 29 5 23.5z',
    );
    expect(existsSync(new URL('../app/favicon.ico', import.meta.url))).toBe(
      false,
    );
  });

  it('spends the accent on the primary sidebar action and primary buttons', () => {
    const primaryAction = css.match(/\.studio-primary-action\s*\{([^}]*)\}/)?.[1];
    expect(primaryAction).toContain('background: var(--studio-accent)');
    expect(primaryAction).toContain('color: var(--studio-canvas)');
    const primaryButton = css.match(/\.studio-button-primary\s*\{([^}]*)\}/)?.[1];
    expect(primaryButton).toContain('background: var(--studio-accent)');
  });

  it('moves account actions into a profile-triggered popover', () => {
    expect(studioNav).toContain('aria-expanded={accountOpen}');
    expect(studioNav).toContain('aria-controls="studio-account-menu"');
    expect(studioNav).not.toContain('role="menu"');
    expect(studioNav).toContain('className="studio-account-popover"');
    expect(studioNav).toContain('href="/settings"');
    expect(studioNav).toContain('onClick={signOut}');
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

  it('keeps the slash-command picker intentional and not re-banned', () => {
    // The retired suggestion grid stays banned above, but the command menu
    // is the intentional replacement — pin it so it cannot be accidentally
    // removed by a future suggestion-grid cleanup.
    expect(chatStudio).toContain('CommandMenu');
    expect(chatStudio).toContain(
      "from '@/components/chat/command-menu'",
    );
  });

  it('keeps builder actions in normal document flow', () => {
    const rule = css.match(/\.studio-builder-footer\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    expect(rule).not.toContain('position: sticky');
    expect(rule).not.toContain('backdrop-filter');
  });
  it('offers only the whitelisted Garage, SearXNG, and Web Reader MCP capabilities', () => {
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
    expect(agentBuilder).toContain('Web Reader');
    expect(agentBuilder).toContain(
      'Read one public web page through the self-hosted Reader and return bounded untrusted Markdown.',
    );
    expect(agentBuilder).toContain("set('mcpClients', toggle(values.mcpClients, mcpClientId))");
    expect(agentBuilder).not.toMatch(
      /mcpUrl|mcpCommand|mcpPackage|mcpCredentials|SEARXNG_BASE_URL|SEARXNG_API_KEY/,
    );
    expect(agentBuilder).not.toMatch(
      /JINA_|WEB_READER_API_KEY|WEB_READER_BASE_URL|readerEndpoint|readerHeaders|readerProxy/,
    );
  });

  it('preserves Garage, SearXNG, Web Reader, or combined selections through detail hydration and model migration', () => {
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

  it('groups weekly and competitive report routes without changing weekly detail URLs', () => {
    expect(reportLandingPage).toContain("export const dynamic = 'force-dynamic'");
    // The landing route collapsed into a pure server redirect; the
    // competitive view is reached through the tabs on each list page.
    expect(reportLandingPage).toContain("redirect('/reports/weekly')");
    expect(reportTabs).toContain("href: '/reports/competitive'");
    expect(reportListPage).toContain('href={`/reports/${encodeURIComponent(report.reportId)}`}');
    expect(competitiveAnalysisListPage).toContain(
      'href={`/reports/competitive/${encodeURIComponent(analysis.analysisId)}`}',
    );
  });

  it('keeps Garage report access server-only', () => {
    expect(reportLandingPage).not.toContain("'use client'");
    expect(reportListPage).not.toContain("'use client'");
    expect(reportDetailPage).not.toContain("'use client'");
    expect(competitiveAnalysisListPage).not.toContain("'use client'");
    expect(competitiveAnalysisDetailPage).not.toContain("'use client'");
    expect(reportListPage).toContain("from '@/server/pm-reports'");
    expect(reportDetailPage).toContain("from '@/server/pm-reports'");
    expect(competitiveAnalysisListPage).toContain("from '@/server/competitive-analyses'");
    expect(competitiveAnalysisDetailPage).toContain("from '@/server/competitive-analyses'");
    expect(reportLandingPage).not.toContain("from '@chekku/storage'");
    expect(reportListPage).not.toContain("from '@chekku/storage'");
    expect(reportDetailPage).not.toContain("from '@chekku/storage'");
    expect(competitiveAnalysisListPage).not.toContain("from '@chekku/storage'");
    expect(competitiveAnalysisDetailPage).not.toContain("from '@chekku/storage'");
  });

  it('keeps report lists accessible as card grids and renders competitive Markdown through shared wrapper', () => {
    expect(reportListPage).toContain('className="studio-report-grid"');
    expect(reportListPage).toContain('aria-label="Saved PM reports"');
    expect(reportListPage).toContain('studio-report-card');
    expect(competitiveAnalysisListPage).toContain('className="studio-report-grid"');
    expect(competitiveAnalysisListPage).toContain('aria-label="Saved competitive analyses"');
    expect(competitiveAnalysisListPage).toContain('studio-report-card');
    expect(competitiveAnalysisDetailPage).toContain('<MarkdownMessage content={analysis.analysisMarkdown} />');
  });

  it('reserves the PM built-in id in the shared identity set', () => {
    expect(types).toContain("export const PM_AGENT_ID = 'pm-agent'");
    expect(types).toMatch(/RESERVED_AGENT_IDS[\s\S]*PM_AGENT_ID/);
  });

  it('hides the supervisor sub-agents from the UI catalog via the shared hidden set', () => {
    const hiddenBlock = types.match(/HIDDEN_AGENT_IDS = new Set<string>\((\[[^\]]*\])\)/)?.[1] ?? '';
    expect(hiddenBlock).not.toBe('');
    for (const id of ['social-media-content-writer', 'social-media-strategist-agent', 'visual-content-agent']) {
      expect(hiddenBlock).toContain(`'${id}'`);
    }
    // The supervisor itself stays visible as the social-media entry point.
    expect(hiddenBlock).not.toContain("'social-media-supervisor-agent'");
    expect(storedAgents).toMatch(/HIDDEN_AGENT_IDS[\s\S]*has\(agent\.id\)/);
  });

  it('clamps every agent-card description to three lines', () => {
    // Long routing descriptions (e.g. the Strategist's) must not stretch the
    // card; the CSS clamps to 3 lines while keeping the full text in the DOM.
    const rule = css.match(/\.studio-agent-card > p\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toContain('display: -webkit-box');
    expect(rule).toContain('-webkit-line-clamp: 3');
    expect(rule).toContain('-webkit-box-orient: vertical');
    expect(rule).toContain('overflow: hidden');
  });

  it('renders reusable agent icons and offers an icon selector in the builder', () => {
    expect(agentCatalogSource).toContain('<AgentIcon icon={agent.iconKey} />');
    expect(agentBuilder).toContain('AGENT_ICON_IDS.map');
    expect(agentBuilder).toContain('aria-label={`Use ${labelForAgentIcon(iconKey)} icon`}');
  });

  it('keeps catalog cards compact and exposes the create-agent card', () => {
    expect(agentCatalogSource).not.toContain('<dt>Model</dt>');
    expect(agentCatalogSource).not.toContain('<dt>Status</dt>');
    expect(agentCatalogSource).toContain('studio-agent-create-card');
    expect(agentCatalogSource).toContain('href="/agents/new"');
    expect(css).toMatch(/\.studio-agent-card\s*\{[\s\S]*min-height:\s*214px/);
  });

  it('routes destructive UI actions through the shared confirmation dialog', () => {
    expect(confirmationDialog).toContain('<dialog');
    expect(confirmationDialog).toContain('aria-labelledby');
    expect(chatStudio).toContain('<ConfirmationDialog');
    expect(agentCatalogSource).toContain('<ConfirmationDialog');
    expect(chatStudio).not.toContain('window.confirm');
    expect(agentCatalogSource).not.toContain('window.confirm');
    expect(chatStudio).toContain('const workspaceHeadingRef = useRef<HTMLHeadingElement>(null)');
    expect(chatStudio).toContain('<h1 ref={workspaceHeadingRef} tabIndex={-1}>');
    expect(chatStudio).toContain('fallbackFocusRef={workspaceHeadingRef}');
  });

  it('explicitly centers the native top-layer confirmation dialog', () => {
    const rule = css.match(/\.studio-confirmation-dialog\s*\{([^}]*)\}/)?.[1];

    expect(rule).toContain('inset: 0');
    expect(rule).toContain('margin: auto');
    expect(rule).toContain('max-height: calc(100dvh - 32px)');
    expect(rule).toContain('overflow-y: auto');
    expect(css).toMatch(/\.studio-confirmation-copy[\s\S]*overflow-wrap:\s*anywhere/);
  });

  it('keeps the slides counter out of the fixed back button corner', () => {
    // Regression: the page-level back button is a fixed top-left overlay, and
    // the counter previously sat at the toolbar's flex-start — the same corner.
    // The counter must be absolutely centered within the toolbar instead.
    const counter = css.match(/\.competitive-slides-counter\s*\{([^}]*)\}/)?.[1];
    const toolbar = css.match(/\.competitive-slides-toolbar\s*\{([^}]*)\}/)?.[1];
    expect(toolbar).toContain('position: relative');
    expect(counter).toContain('position: absolute');
    expect(counter).toContain('left: 50%');
    expect(counter).toContain('translateX(-50%)');
    // On narrow screens the centered overlay cannot fit between the back
    // button and the toolbar buttons, so the back button re-enters the flow
    // and the counter returns to the flex row — no overlap by construction.
    const narrow = css.match(/@media \(max-width: 480px\)\s*\{([\s\S]*?)\n\}/)?.[1];
    expect(narrow).toMatch(/\.competitive-slides-page-back\s*\{[^}]*position:\s*static/s);
    expect(narrow).toMatch(/\.competitive-slides-counter\s*\{[^}]*position:\s*static/s);
  });

  it('separates agent preparation from guarded deletion state', () => {
    expect(agentCatalogSource).toContain('const deleteInFlightRef = useRef(false)');
    expect(agentCatalogSource).toContain('const [deletingAgentId, setDeletingAgentId]');
    expect(agentCatalogSource).toContain('if (!agent || deleteInFlightRef.current) return');
    expect(agentCatalogSource).toContain('fallbackFocusRef={registryHeadingRef}');
  });

  it('guards thread deletion against a double-confirm the same way', () => {
    expect(chatStudio).toContain('const deleteInFlightRef = useRef(false)');
    expect(chatStudio).toContain(
      'if (!target || deleteInFlightRef.current) return',
    );
    // Deletion is blocked only for threads with a live run — never by
    // component-local streaming state.
    expect(chatStudio).toContain('if (threadHasActiveRun(target.id))');
    expect(chatStudio).toContain('deleteInFlightRef.current = false');
  });

  it('disables incidental motion and safely aligns short auth layouts', () => {
    const reducedMotion = css.match(
      /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/,
    )?.[1] ?? '';
    expect(reducedMotion).toContain('.studio-resizable-sidebar.is-collapsed .studio-sidebar-collapse');
    expect(reducedMotion).toContain('.studio-icon-picker button');
    expect(reducedMotion).toContain('transition: none');

    const shortAuth = css.match(
      /@media \(max-height: 950px\) and \(min-width: 761px\)\s*\{([\s\S]*?)\n\}/,
    )?.[1] ?? '';
    // Short-viewport alignment is carried by the shell padding and the
    // frame's min-height: `.auth-frame { margin: auto }` absorbs all free
    // space, so any place-content here would be inert.
    expect(shortAuth).toMatch(/\.auth-shell\s*\{[^}]*padding-block:\s*20px/s);
    expect(shortAuth).toMatch(
      /\.auth-frame\s*\{[^}]*min-height:\s*calc\(100dvh - 40px\)/s,
    );
    expect(shortAuth).not.toMatch(/place-content/);
  });

  it('renders the competitive slides route through the shared client component and never touches Garage directly', () => {
    expect(competitiveAnalysisSlidesPage).toContain("export const dynamic = 'force-dynamic'");
    expect(competitiveAnalysisSlidesPage).not.toContain("'use client'");
    expect(competitiveAnalysisSlidesPage).toContain("from '@/components/competitive-slides'");
    expect(competitiveAnalysisSlidesPage).toContain("from '@/server/competitive-analyses'");
    expect(competitiveAnalysisSlidesPage).not.toContain('from \'@chekku/storage\'');
  });

  it('renders the public slides route as unauthenticated, never touches Garage directly, and reads only via getPublicSlides', () => {
    expect(publicSlidesPage).toContain("export const dynamic = 'force-dynamic'");
    expect(publicSlidesPage).not.toContain("'use client'");
    expect(publicSlidesPage).toContain("from '@/components/competitive-slides'");
    expect(publicSlidesPage).toContain("from '@/server/competitive-analyses'");
    expect(publicSlidesPage).toContain('getPublicSlides');
    expect(publicSlidesPage).not.toContain('from \'@chekku/storage\'');
    expect(publicSlidesPage).not.toContain('getCompetitiveAnalysisForUser');
    expect(publicSlidesPage).not.toContain('requireIdentity');
  });
});
