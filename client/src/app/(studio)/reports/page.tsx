import { permanentRedirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function ReportsPage() {
  permanentRedirect('/reports/weekly');
}
