import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
  } catch {
    throw new Error(`Invalid IANA timezone: ${timeZone}`);
  }
}

function zonedParts(date: Date, timeZone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

function utcOffset(date: Date, timeZone: string): string {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const offsetMinutes = Math.round((asUtc - date.getTime()) / 60_000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

export function currentTimeSnapshot(timeZone = 'Asia/Jakarta', now = new Date()) {
  assertTimeZone(timeZone);
  return {
    iso: now.toISOString(),
    date: new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now),
    time: new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).format(now),
    dayOfWeek: new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(now),
    timezone: timeZone,
    utcOffset: utcOffset(now, timeZone),
    epochMs: now.getTime(),
  };
}

export const getCurrentTimeTool = createTool({
  id: 'get-current-time',
  description:
    "Get the current date and time in an IANA timezone. Use this before resolving relative dates such as today, tomorrow, next week, or a user's local time.",
  inputSchema: z.object({
    timezone: z.string().optional().describe('IANA timezone, for example Asia/Jakarta. Defaults to Asia/Jakarta.'),
  }),
  outputSchema: z.object({
    iso: z.string(),
    date: z.string(),
    time: z.string(),
    dayOfWeek: z.string(),
    timezone: z.string(),
    utcOffset: z.string(),
    epochMs: z.number(),
  }),
  execute: async ({ timezone }) => currentTimeSnapshot(timezone),
});
