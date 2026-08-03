import { AgentBuilderPage } from '@/components/agents/agent-builder-page';
import { requireUserId } from '@/server/auth';

export default async function EditAgentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const resourceId = await requireUserId();
  return (
    <AgentBuilderPage
      mode="edit"
      agentId={decodeURIComponent(id)}
      resourceId={resourceId}
    />
  );
}
