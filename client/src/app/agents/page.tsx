import { AgentCatalogPage } from '@/components/agents/agent-catalog-page';

export default function AgentsPage() {
  const resourceId = process.env.CHEKKU_LOCAL_USER_ID || 'local-user';
  return <AgentCatalogPage resourceId={resourceId} />;
}
