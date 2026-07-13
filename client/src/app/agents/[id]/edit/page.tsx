import { AgentBuilderPage } from '@/components/agents/agent-builder-page';

export default async function EditAgentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const resourceId = process.env.CHEKKU_LOCAL_USER_ID || 'local-user';
  return (
    <AgentBuilderPage
      mode="edit"
      agentId={decodeURIComponent(id)}
      resourceId={resourceId}
    />
  );
}
