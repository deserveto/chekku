import { AgentBuilderPage } from '@/components/agents/agent-builder-page';

export default function NewAgentPage() {
  const resourceId = process.env.CHEKKU_LOCAL_USER_ID || 'local-user';
  return <AgentBuilderPage mode="create" resourceId={resourceId} />;
}
