import { describe, expect, it } from 'vitest';
import { currentTimeSnapshot } from './get-current-time.js';

describe('currentTimeSnapshot', () => {
  it('returns a deterministic Jakarta snapshot', () => {
    const result = currentTimeSnapshot('Asia/Jakarta', new Date('2026-07-12T07:00:00.000Z'));
    expect(result).toMatchObject({
      iso: '2026-07-12T07:00:00.000Z',
      date: '2026-07-12',
      time: '14:00:00',
      dayOfWeek: 'Sunday',
      timezone: 'Asia/Jakarta',
      utcOffset: '+07:00',
    });
  });

  it('rejects invalid timezones', () => {
    expect(() => currentTimeSnapshot('Mars/Olympus')).toThrow('Invalid IANA timezone');
  });
});
