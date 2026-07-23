import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  createPublicHolidayClient,
  filterAndDedupeHolidays,
  parsePublicHoliday,
  type PublicHoliday,
} from '../public-holidays.js';

function makeResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('parsePublicHoliday', () => {
  it('extracts name and Hijri year when the description carries one', () => {
    expect(parsePublicHoliday({ date: '2026-03-21', description: 'Hari Raya Idul Fitri 1447 Hijriyah' }))
      .toEqual({
        date: '2026-03-21',
        name: 'Hari Raya Idul Fitri',
        hijriYear: 1447,
        description: 'Hari Raya Idul Fitri 1447 Hijriyah',
      });
    expect(parsePublicHoliday({ date: '2026-06-16', description: 'Tahun Baru Islam 1448 Hijriyah' })?.hijriYear)
      .toBe(1448);
  });

  it('leaves hijriYear undefined for non-Hijri descriptions', () => {
    const parsed = parsePublicHoliday({ date: '2026-08-17', description: 'Hari Kemerdekaan Republik Indonesia' });
    expect(parsed?.hijriYear).toBeUndefined();
    expect(parsed?.name).toBe('Hari Kemerdekaan Republik Indonesia');
  });

  it('returns undefined for malformed dates', () => {
    expect(parsePublicHoliday({ date: '21-03-2026', description: 'Hari' })).toBeUndefined();
    expect(parsePublicHoliday({ date: 'not-a-date', description: 'Hari' })).toBeUndefined();
  });

  it('returns undefined when description is empty or wrong type', () => {
    expect(parsePublicHoliday({ date: '2026-08-17', description: '   ' })).toBeUndefined();
    expect(parsePublicHoliday({ date: '2026-08-17', description: undefined })).toBeUndefined();
    expect(parsePublicHoliday({ date: undefined, description: 'Hari' })).toBeUndefined();
  });
});

describe('filterAndDedupeHolidays', () => {
  const idulFitri = (date: string, hijriYear = 1447): PublicHoliday => ({
    date,
    name: 'Hari Raya Idul Fitri',
    hijriYear,
    description: `Hari Raya Idul Fitri ${hijriYear} Hijriyah`,
  });

  it('skips entries whose name starts with "Cuti Bersama"', () => {
    const out = filterAndDedupeHolidays([
      { date: '2026-03-20', name: 'Cuti Bersama Hari Raya Idul Fitri 1447 Hijriyah', description: 'x' },
      idulFitri('2026-03-21'),
    ]);
    expect(out.map((h) => h.date)).toEqual(['2026-03-21']);
  });

  it('keeps the earliest date for multi-day holidays that share a name', () => {
    const out = filterAndDedupeHolidays([
      idulFitri('2026-03-22'),
      idulFitri('2026-03-21'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.date).toBe('2026-03-21');
  });

  it('keeps distinct holidays with different names', () => {
    const out = filterAndDedupeHolidays([
      idulFitri('2026-03-21'),
      { date: '2026-05-27', name: 'Hari Raya Idul Adha', hijriYear: 1447, description: 'Hari Raya Idul Adha 1447 Hijriyah' },
    ]);
    expect(out.map((h) => h.name)).toEqual(['Hari Raya Idul Fitri', 'Hari Raya Idul Adha']);
  });

  it('handles empty input', () => {
    expect(filterAndDedupeHolidays([])).toEqual([]);
  });
});

describe('createPublicHolidayClient', () => {
  function payload(): unknown {
    return {
      status: 'success',
      code: 200,
      data: [
        { date: '2026-03-20', description: 'Cuti Bersama Hari Raya Idul Fitri 1447 Hijriyah' },
        { date: '2026-03-21', description: 'Hari Raya Idul Fitri 1447 Hijriyah' },
        { date: '2026-03-22', description: 'Hari Raya Idul Fitri 1447 Hijriyah' },
        { date: '2026-08-17', description: 'Hari Kemerdekaan Republik Indonesia' },
      ],
      message: 'Holidays Found',
    };
  }

  it('fetches, parses, filters, and dedupes in one pass', async () => {
    const fetch = vi.fn(async () => makeResponse(payload()));
    const client = createPublicHolidayClient({
      apiUrl: 'https://api-hari-libur.vercel.app/api',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    const holidays = await client.getHolidays(2026);

    expect(fetch).toHaveBeenCalledTimes(1);
    const calledUrl = (fetch.mock.calls[0] as unknown[])[0] as URL;
    expect(calledUrl.toString()).toContain('year=2026');
    expect(holidays.map((h) => h.name)).toEqual([
      'Hari Raya Idul Fitri',
      'Hari Kemerdekaan Republik Indonesia',
    ]);
    expect(holidays[0]!.hijriYear).toBe(1447);
    expect(holidays[1]!.hijriYear).toBeUndefined();
  });

  it('caches the response per year on the filesystem and skips the network on the second call', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'chekku-holidays-'));
    try {
      const fetch = vi.fn(async () => makeResponse(payload()));
      const client = createPublicHolidayClient({
        apiUrl: 'https://api-hari-libur.vercel.app/api',
        cacheDir,
        fetch: fetch as unknown as typeof globalThis.fetch,
      });

      const first = await client.getHolidays(2026);
      const second = await client.getHolidays(2026);

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('reads an existing cache file without hitting the network at all', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'chekku-holidays-'));
    try {
      const cached = [
        { date: '2026-03-21', description: 'Hari Raya Idul Fitri 1447 Hijriyah' },
      ];
      writeFileSync(join(cacheDir, 'holidays-2026.json'), JSON.stringify(cached));

      const fetch = vi.fn(async () => makeResponse(payload()));
      const client = createPublicHolidayClient({
        apiUrl: 'https://api-hari-libur.vercel.app/api',
        cacheDir,
        fetch: fetch as unknown as typeof globalThis.fetch,
      });

      const holidays = await client.getHolidays(2026);

      expect(fetch).not.toHaveBeenCalled();
      expect(holidays.map((h) => h.name)).toEqual(['Hari Raya Idul Fitri']);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('throws a safe "unavailable" error when fetch fails and no cache exists', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('network down');
    });
    const client = createPublicHolidayClient({
      apiUrl: 'https://api-hari-libur.vercel.app/api',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await expect(client.getHolidays(2026)).rejects.toThrow('Public holiday API is unavailable');
  });

  it('rejects years outside the supported range', async () => {
    const fetch = vi.fn(async () => makeResponse(payload()));
    const client = createPublicHolidayClient({
      apiUrl: 'https://api-hari-libur.vercel.app/api',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await expect(client.getHolidays(1999)).rejects.toThrow();
    await expect(client.getHolidays(2101)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects non-2xx upstream responses', async () => {
    const fetch = vi.fn(async () => makeResponse({}, { status: 500 }));
    const client = createPublicHolidayClient({
      apiUrl: 'https://api-hari-libur.vercel.app/api',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await expect(client.getHolidays(2026)).rejects.toThrow('Public holiday API is unavailable');
  });

  it('rejects responses whose content-type is not JSON', async () => {
    const fetch = vi.fn(async () =>
      new Response('<html>5xx page</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const client = createPublicHolidayClient({
      apiUrl: 'https://api-hari-libur.vercel.app/api',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await expect(client.getHolidays(2026)).rejects.toThrow('did not return JSON');
  });

  it('surfaces a parse error when the payload shape is invalid', async () => {
    const fetch = vi.fn(async () => makeResponse({ status: 'success', data: 'not-an-array' }));
    const client = createPublicHolidayClient({
      apiUrl: 'https://api-hari-libur.vercel.app/api',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await expect(client.getHolidays(2026)).rejects.toThrow('invalid response');
  });
});
