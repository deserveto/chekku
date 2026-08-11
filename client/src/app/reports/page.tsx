import Link from 'next/link';

import { AgentIcon } from '@/components/agents/agent-icon';
import { StudioNav } from '@/components/studio/studio-nav';
import { ReportTabs } from '@/components/reports/report-tabs';
import { requireUserId } from '@/server/auth';

export const dynamic = 'force-dynamic';

export default async function ReportsPage() {
  const resourceId = await requireUserId();

  return (
    <div className="studio-shell">
      <StudioNav resourceId={resourceId} />
      <main className="studio-main">
        <header className="studio-page-header">
          <div>
            <p className="studio-eyebrow">Garage storage</p>
            <h1>Reports</h1>
            <p>Choose saved weekly risk reviews or product competitive analyses.</p>
          </div>
        </header>

        <section className="studio-section">
          <ReportTabs active="all" />
          <div className="studio-report-choice-grid">
            <Link className="studio-agent-card studio-report-choice" href="/reports/weekly">
              <div className="studio-agent-card-top">
                <span className="studio-agent-glyph"><AgentIcon icon="chart" /></span>
                <span className="studio-source-badge">Risk review</span>
              </div>
              <div className="studio-report-choice-body">
                <h2>Weekly Reports</h2>
                <code>weekly-risk-review</code>
              </div>
              <p>Review saved engineering weekly analyses, risk ratings, and original weekly input.</p>
              <dl className="studio-agent-meta">
                <div>
                  <dt>Type</dt>
                  <dd>Risk review</dd>
                </div>
                <div>
                  <dt>Curated by</dt>
                  <dd>PM Agent</dd>
                </div>
              </dl>
              <div className="studio-card-actions">
                <span className="studio-button studio-button-primary" aria-hidden="true">Browse reports →</span>
              </div>
            </Link>
            <Link className="studio-agent-card studio-report-choice" href="/reports/competitive">
              <div className="studio-agent-card-top">
                <span className="studio-agent-glyph"><AgentIcon icon="compass" /></span>
                <span className="studio-source-badge">Market research</span>
              </div>
              <div className="studio-report-choice-body">
                <h2>Competitive Analyses</h2>
                <code>competitive-analysis</code>
              </div>
              <p>Review saved product comparisons, feature matrices, and recommendations.</p>
              <dl className="studio-agent-meta">
                <div>
                  <dt>Type</dt>
                  <dd>Market research</dd>
                </div>
                <div>
                  <dt>Curated by</dt>
                  <dd>PM Agent</dd>
                </div>
              </dl>
              <div className="studio-card-actions">
                <span className="studio-button studio-button-primary" aria-hidden="true">Browse analyses →</span>
              </div>
            </Link>
          </div>
        </section>
      </main>
    </div>
  );
}
