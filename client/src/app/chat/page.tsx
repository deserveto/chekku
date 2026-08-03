import { redirect } from 'next/navigation';
import { ChatStudio } from '@/components/chat/chat-studio';
import { resolveChatIdentity } from '@/lib/chat-route';
import { requireUserId } from '@/server/auth';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const resourceId = await requireUserId();
  const resolved = resolveChatIdentity(query, resourceId);

  if (
    resolved.generated ||
    first(query.agent) !== resolved.agentId ||
    first(query.thread) !== resolved.threadId
  ) {
    redirect(resolved.canonicalHref);
  }

  return (
    <ChatStudio
      resourceId={resourceId}
      initialAgentId={resolved.agentId}
      initialThreadId={resolved.threadId}
    />
  );
}
