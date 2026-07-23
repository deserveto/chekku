import Link from 'next/link';

import { StudioNav } from '@/components/studio/studio-nav';

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
              <p className="studio-eyebrow">Risk review</p>
              <h2>Weekly Reports</h2>
              <p>Review saved engineering weekly analyses and risk ratings.</p>
            </Link>
            <Link className="studio-report-choice studio-panel" href="/reports/competitive">
              <p className="studio-eyebrow">Market research</p>
              <h2>Competitive Analyses</h2>
              <p>Review saved product comparisons, feature matrices, and recommendations.</p>
            </Link>
          </div>
        </section>
      </main>
    </div>
  );
}
