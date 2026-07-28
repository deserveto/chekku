import 'server-only';

import { parseSocialPostTimestamp } from '@chekku/storage';

export function formatSocialPostCreatedAt(createdAt: string): string {
  const timestamp = parseSocialPostTimestamp(createdAt);
  if (timestamp === undefined) return createdAt;
  return `${new Date(timestamp).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
