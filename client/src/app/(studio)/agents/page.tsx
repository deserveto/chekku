import { AgentCatalogPage } from '@/components/agents/agent-catalog-page';
import { requireUserId } from '@/server/auth';

export default async function AgentsPage() {
  const resourceId = await requireUserId();
  return <AgentCatalogPage resourceId={resourceId} />;
}
