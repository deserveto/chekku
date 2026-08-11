import Link from 'next/link';

type ReportView = 'all' | 'weekly' | 'competitive';

const views: Array<{ id: ReportView; label: string; href: string }> = [
  { id: 'all', label: 'Overview', href: '/reports' },
  { id: 'weekly', label: 'Weekly reviews', href: '/reports/weekly' },
  { id: 'competitive', label: 'Competitive', href: '/reports/competitive' },
];

export function ReportTabs({ active }: { active: ReportView }) {
  return (
    <nav className="studio-report-tabs" aria-label="Report views">
      {views.map((view) => (
        <Link
          key={view.id}
          href={view.href}
          className={active === view.id ? 'active' : undefined}
          aria-current={active === view.id ? 'page' : undefined}
        >
          {view.label}
        </Link>
      ))}
    </nav>
  );
}
