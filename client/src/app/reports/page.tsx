import Link from 'next/link';

import { StudioNav } from '@/components/studio/studio-nav';

export const dynamic = 'force-dynamic';

export default async function ReportsPage() {
  const resourceId = process.env.CHEKKU_LOCAL_USER_ID || 'local-user';

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
          <div className="studio-report-choice-grid">
            <Link className="studio-report-choice studio-panel" href="/reports/weekly">
              <div className="studio-agent-card-top">
                <span className="studio-agent-glyph" aria-hidden="true">◇</span>
                <span className="studio-source-badge">Risk review</span>
              </div>
              <h2>Weekly Reports</h2>
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
            <Link className="studio-report-choice studio-panel" href="/reports/competitive">
              <div className="studio-agent-card-top">
                <span className="studio-agent-glyph" aria-hidden="true">◎</span>
                <span className="studio-source-badge">Market research</span>
              </div>
              <h2>Competitive Analyses</h2>
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
