import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Public Holiday Indonesia API client.
 *
 * Backed by `https://api-hari-libur.vercel.app/api` (free, no auth). The API
 * returns Indonesian national holidays plus major religious observances
 * (Idul Fitri, Idul Adha, Tahun Baru Islam / 1 Muharram, Isra Mi'raj, Maulid
 * Nabi, Nyepi, Paskah, Waisak, Natal, etc.) with their Gregorian dates and,
 * for Islamic holidays, the Hijri year label inside the description.
 *
 * This module mirrors the SearXNG client's bounded-transport contract:
 *  - fixed endpoint, no auth header, no arbitrary configuration;
 *  - timeout + max body size + reject redirects;
 *  - safe fixed errors that never leak the endpoint URL or diagnostics;
 *  - per-year file cache so a single fire does not re-fetch 30+ years of
 *    data, and an offline API does not take the workflow down with it.
 *
 * Only the weekly-social-drafts workflow consumes this — no MCP server is
 * exposed, no agent tool is registered. Holidays are not generic agent
 * storage or search; they are a calendar input, so this stays a workflow
 * dependency.
 */

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_BODY_BYTES = 1 * 1024 * 1024;
const HIJRI_SUFFIX_RE = /\s+(\d{3,4})\s+Hijriyah$/i;
const CUTI_BERSAMA_RE = /^Cuti\s+Bersama/i;

const ERRORS = {
  unavailable: 'Public holiday API is unavailable. Try again later.',
  timeout: 'Public holiday API timed out. Try again.',
  format: 'The configured Public holiday API did not return JSON.',
  tooLarge: 'Public holiday API returned too much data.',
  invalid: 'Public holiday API returned an invalid response.',
} as const;

type ClientErrorCategory = keyof typeof ERRORS;

class PublicHolidayClientError extends Error {
  constructor(readonly category: ClientErrorCategory) {
    super(ERRORS[category]);
  }
}

export interface PublicHoliday {
  /** ISO Gregorian date `YYYY-MM-DD`. */
  date: string;
  /** Clean holiday name, e.g. "Hari Raya Idul Fitri". */
  name: string;
  /** Hijri year parsed from the description, when the API included one. */
  hijriYear?: number;
  /** Original description from the upstream API. */
  description: string;
}

export interface PublicHolidayClient {
  getHolidays(year: number): Promise<PublicHoliday[]>;
}

export interface PublicHolidayOptions {
  /** Fully-qualified API URL (including the `/api` path). */
  apiUrl: string;
  /** Inject fetch for tests. */
  fetch?: typeof globalThis.fetch;
  /** Directory for the per-year JSON cache. */
  cacheDir?: string;
  /** Override timeout (defaults to 12s, mirrors SearXNG). */
  timeoutMs?: number;
}

interface ApiPayload {
  status?: unknown;
  code?: unknown;
  data?: unknown;
  message?: unknown;
}

/**
 * Parse a single raw `{ date, description }` entry from the upstream API
 * into a `PublicHoliday`. Extracts the Hijri year from the description when
 * the upstream included one (e.g. "Hari Raya Idul Fitri 1447 Hijriyah").
 *
 * Public so it can be unit-tested without HTTP.
 */
export function parsePublicHoliday(raw: { date?: unknown; description?: unknown }): PublicHoliday | undefined {
  if (typeof raw.date !== 'string' || typeof raw.description !== 'string') return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.date)) return undefined;
  const description = raw.description.trim();
  if (!description) return undefined;

  const match = HIJRI_SUFFIX_RE.exec(description);
  const name = (match ? description.slice(0, match.index) : description).trim();
  if (!name) return undefined;

  const holiday: PublicHoliday = {
    date: raw.date,
    name,
    description,
  };
  if (match) {
    const year = Number(match[1]);
    if (Number.isInteger(year) && year > 0) holiday.hijriYear = year;
  }
  return holiday;
}

/**
 * Filter `Cuti Bersama` (joint leave days) and deduplicate multi-day
 * holidays by name within the supplied list. For multi-day entries that
 * share a name (e.g. Idul Fitri 03-21 + 03-22), only the earliest date is
 * retained so the workflow posts once per holiday.
 *
 * Public for unit testing.
 */
export function filterAndDedupeHolidays(input: readonly PublicHoliday[]): PublicHoliday[] {
  const seenNames = new Set<string>();
  const out: PublicHoliday[] = [];
  const sorted = [...input].sort((a, b) => a.date.localeCompare(b.date));
  for (const holiday of sorted) {
    if (CUTI_BERSAMA_RE.test(holiday.name)) continue;
    if (seenNames.has(holiday.name)) continue;
    seenNames.add(holiday.name);
    out.push(holiday);
  }
  return out;
}

function normalizePayload(payload: unknown): PublicHoliday[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new PublicHolidayClientError('invalid');
  }
  const record = payload as ApiPayload;
  if (!Array.isArray(record.data)) throw new PublicHolidayClientError('invalid');

  const holidays: PublicHoliday[] = [];
  for (const entry of record.data) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const parsed = parsePublicHoliday(entry as { date?: unknown; description?: unknown });
    if (parsed) holidays.push(parsed);
  }
  return filterAndDedupeHolidays(holidays);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new PublicHolidayClientError('unavailable');
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
  if (!contentType || !/^application\/(?:json|[^/;+]+\+json)$/i.test(contentType)) {
    throw new PublicHolidayClientError('format');
  }
  if (!response.body) throw new PublicHolidayClientError('invalid');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new PublicHolidayClientError('tooLarge');
    }
    chunks.push(value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown;
  } catch {
    throw new PublicHolidayClientError('invalid');
  }
}

function cachePathFor(cacheDir: string, year: number): string {
  return resolve(cacheDir, `holidays-${year}.json`);
}

function readCache(cacheDir: string, year: number): PublicHoliday[] | undefined {
  const path = cachePathFor(cacheDir, year);
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, 'utf8');
    const payload = JSON.parse(raw) as unknown;
    if (!Array.isArray(payload)) return undefined;
    const parsed = payload
      .map((entry) => (entry && typeof entry === 'object'
        ? parsePublicHoliday(entry as { date?: unknown; description?: unknown })
        : undefined))
      .filter((entry): entry is PublicHoliday => entry !== undefined);
    return parsed.length === 0 ? undefined : parsed;
  } catch {
    return undefined;
  }
}

function writeCache(cacheDir: string, year: number, holidays: PublicHoliday[]): void {
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cachePathFor(cacheDir, year), JSON.stringify(holidays, null, 2), { mode: 0o600 });
  } catch {
    // Cache write failure is non-fatal — we still return the live data.
  }
}

export function createPublicHolidayClient(options: PublicHolidayOptions): PublicHolidayClient {
  const fetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async getHolidays(year: number): Promise<PublicHoliday[]> {
      if (!Number.isInteger(year) || year < 2000 || year > 2100) {
        throw new PublicHolidayClientError('invalid');
      }

      if (options.cacheDir) {
        const cached = readCache(options.cacheDir, year);
        if (cached) return cached;
      }

      const url = new URL(options.apiUrl);
      url.searchParams.set('year', String(year));

      let payload: unknown;
      try {
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const response = await fetch(url, {
          method: 'GET',
          redirect: 'error',
          signal: timeoutSignal,
          headers: { Accept: 'application/json' },
        });
        payload = await readBoundedJson(response);
      } catch (error) {
        if (error instanceof PublicHolidayClientError) throw error;
        if (error instanceof Error && error.name === 'TimeoutError') {
          throw new PublicHolidayClientError('timeout');
        }
        throw new PublicHolidayClientError('unavailable');
      }

      const holidays = normalizePayload(payload);
      if (options.cacheDir) writeCache(options.cacheDir, year, holidays);
      return holidays;
    },
  };
}
