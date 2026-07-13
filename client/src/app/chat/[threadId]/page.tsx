import { redirect } from 'next/navigation';
import { buildChatHref, normalizeAgentId } from '@/lib/chat-route';

export default async function LegacyChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ threadId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ threadId }, query] = await Promise.all([params, searchParams]);
  const rawAgent = Array.isArray(query.agent) ? query.agent[0] : query.agent;
  redirect(buildChatHref(normalizeAgentId(rawAgent), threadId));
}
