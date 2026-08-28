import { StudioNav } from '@/components/studio/studio-nav';
import { requireUserId } from '@/server/auth';

export default async function StudioLayout({ children }: { children: React.ReactNode }) {
  const resourceId = await requireUserId();
  return (
    <div className="studio-shell">
      <StudioNav resourceId={resourceId} />
      <main className="studio-main">{children}</main>
    </div>
  );
}