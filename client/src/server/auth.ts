import 'server-only';

/** Server-controlled identity. Replace this implementation when OIDC is added. */
export async function getUserId(): Promise<string | null> {
  return process.env.CHEKKU_LOCAL_USER_ID ?? 'local-user';
}

/** Optional service credential for the studio -> agent-server hop. */
export async function getDownstreamToken(userId: string): Promise<string | null> {
  void userId;
  return process.env.AGENT_SERVICE_TOKEN || null;
}
