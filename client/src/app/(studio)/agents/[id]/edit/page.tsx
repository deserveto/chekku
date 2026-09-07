import { AgentBuilderPage } from '@/components/agents/agent-builder-page';

export default async function EditAgentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <AgentBuilderPage mode="edit" agentId={decodeURIComponent(id)} />;
}
