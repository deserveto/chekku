import 'server-only';

import { parsePmReportTimestamp } from '@chekku/storage';

export function formatPmReportCreatedAt(createdAt: string): string {
  const timestamp = parsePmReportTimestamp(createdAt);
  if (timestamp === undefined) return createdAt;
  return `${new Date(timestamp).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
