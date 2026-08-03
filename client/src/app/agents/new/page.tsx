import { AgentBuilderPage } from '@/components/agents/agent-builder-page';
import { requireUserId } from '@/server/auth';

export default async function NewAgentPage() {
  const resourceId = await requireUserId();
  return <AgentBuilderPage mode="create" resourceId={resourceId} />;
}
