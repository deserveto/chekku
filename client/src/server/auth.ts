import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';

export async function getUserId(): Promise<string | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user.id ?? null;
}

export async function requireUserId(): Promise<string> {
  const userId = await getUserId();
  if (!userId) redirect('/login');
  return userId;
}

export async function getDownstreamToken(userId: string): Promise<string | null> {
  void userId;
  return process.env.AGENT_SERVICE_TOKEN || null;
}
