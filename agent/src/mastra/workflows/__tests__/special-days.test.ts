import { describe, expect, it } from 'vitest';

import {
  SPECIAL_DAYS,
  EVERGREEN_PILLARS,
  evergreenPillarsForWeek,
  pickTopics,
  selectBonusAwarenessDayForWeek,
  selectTopicsForWeek,
  specialDaysForWeek,
  weekDates,
  weekStartLabel,
} from '../special-days.js';

const MONTH_DAY_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

// 2026-07-17 is a Friday in Asia/Jakarta; Monday of that week is 2026-07-13.
const friday = new Date('2026-07-17T09:00:00+07:00');
// 2026-08-17 is a Monday (Independence Day).
const mondayAugust = new Date('2026-08-17T09:00:00+07:00');
// 2026-12-21 is a Monday; its week contains 12-22 (Hari Ibu) and 12-25 (Natal).
const mondayDecember = new Date('2026-12-21T09:00:00+07:00');
// 2026-12-28 is a Monday; its week spans the year boundary into 2027-01-01.
const mondayYearBoundary = new Date('2026-12-28T09:00:00+07:00');

describe('weekDates', () => {
  it('returns 7 MM-DD values opening on Monday for a Friday input', () => {
    expect(weekDates(friday)).toEqual([
      '07-13', '07-14', '07-15', '07-16', '07-17', '07-18', '07-19',
    ]);
  });

  it('returns 7 values starting Monday for a Monday input', () => {
    expect(weekDates(mondayAugust)).toEqual([
      '08-17', '08-18', '08-19', '08-20', '08-21', '08-22', '08-23',
    ]);
  });

  it('spans the year boundary correctly', () => {
    expect(weekDates(mondayYearBoundary)).toEqual([
      '12-28', '12-29', '12-30', '12-31', '01-01', '01-02', '01-03',
    ]);
  });

  it('always emits exactly 7 well-formed MM-DD values', () => {
    for (const now of [friday, mondayAugust, mondayDecember, mondayYearBoundary]) {
      const dates = weekDates(now);
      expect(dates).toHaveLength(7);
      for (const value of dates) expect(MONTH_DAY_RE.test(value)).toBe(true);
    }
  });
});

describe('weekStartLabel', () => {
  it('formats the Monday opening the week as YYYY-MM-DD', () => {
    expect(weekStartLabel(friday)).toBe('2026-07-13');
    expect(weekStartLabel(mondayDecember)).toBe('2026-12-21');
    expect(weekStartLabel(mondayYearBoundary)).toBe('2026-12-28');
  });
});

describe('specialDaysForWeek', () => {
  it('returns no days for a week without awareness days', () => {
    expect(specialDaysForWeek(friday)).toEqual([]);
  });

  it('returns Independence Day for the week of 2026-08-17', () => {
    const days = specialDaysForWeek(mondayAugust);
    expect(days.map((day) => day.name)).toEqual(['Hari Kemerdekaan Republik Indonesia']);
  });

  it('returns both Hari Ibu and Natal for the week of 2026-12-21', () => {
    const days = specialDaysForWeek(mondayDecember);
    expect(days.map((day) => day.name)).toEqual(['Hari Ibu', 'Hari Raya Natal']);
  });

  it('finds Tahun Baru across the year boundary', () => {
    const days = specialDaysForWeek(mondayYearBoundary);
    expect(days.map((day) => day.name)).toEqual(['Tahun Baru Masehi']);
  });
});

describe('pickTopics', () => {
  const special = [
    { date: '12-22', name: 'Hari Ibu', angle: 'a' },
    { date: '12-25', name: 'Hari Raya Natal', angle: 'b' },
    { date: '01-01', name: 'Tahun Baru Masehi', angle: 'c' },
  ];
  const pillars = [
    { id: 'tips', name: 'Tips & Trik', angle: 'p1' },
    { id: 'product', name: 'Sorotan Produk', angle: 'p2' },
  ];

  it('fills all slots with evergreen pillars when there are no special days', () => {
    expect(pickTopics([], pillars)).toEqual([
      { kind: 'evergreen', name: 'Tips & Trik', angle: 'p1' },
      { kind: 'evergreen', name: 'Sorotan Produk', angle: 'p2' },
    ]);
  });

  it('places one special day first, then fills with an evergreen pillar', () => {
    expect(pickTopics(special.slice(0, 1), pillars)).toEqual([
      { kind: 'special-day', name: 'Hari Ibu', angle: 'a', specialDay: 'Hari Ibu' },
      { kind: 'evergreen', name: 'Tips & Trik', angle: 'p1' },
    ]);
  });

  it('takes exactly 2 special days and ignores the rest', () => {
    expect(pickTopics(special, pillars)).toEqual([
      { kind: 'special-day', name: 'Hari Ibu', angle: 'a', specialDay: 'Hari Ibu' },
      { kind: 'special-day', name: 'Hari Raya Natal', angle: 'b', specialDay: 'Hari Raya Natal' },
    ]);
  });

  it('clamps a negative count to zero topics', () => {
    expect(pickTopics(special, pillars, -1)).toEqual([]);
  });
});

describe('evergreenPillarsForWeek', () => {
  it('is deterministic for the same week', () => {
    expect(evergreenPillarsForWeek(friday, 2)).toEqual(evergreenPillarsForWeek(friday, 2));
  });

  it('rotates by one position between consecutive weeks', () => {
    const thisWeek = evergreenPillarsForWeek(friday, 2);
    const nextWeek = evergreenPillarsForWeek(new Date('2026-07-24T09:00:00+07:00'), 2);
    expect(thisWeek).toHaveLength(2);
    expect(nextWeek).toHaveLength(2);
    expect(thisWeek[1]).toEqual(nextWeek[0]);
    expect(thisWeek).not.toEqual(nextWeek);
  });

  it('returns adjacent pillars from the canonical rotation', () => {
    const pillars = evergreenPillarsForWeek(friday, 2);
    const firstIndex = EVERGREEN_PILLARS.findIndex((pillar) => pillar.id === pillars[0]!.id);
    const secondIndex = EVERGREEN_PILLARS.findIndex((pillar) => pillar.id === pillars[1]!.id);
    expect(secondIndex).toBe((firstIndex + 1) % EVERGREEN_PILLARS.length);
  });

  it('returns an empty array for count 0 or negative', () => {
    expect(evergreenPillarsForWeek(friday, 0)).toEqual([]);
    expect(evergreenPillarsForWeek(friday, -3)).toEqual([]);
  });
});

describe('selectTopicsForWeek', () => {
  it('always returns exactly 2 topics', () => {
    for (const now of [friday, mondayAugust, mondayDecember, mondayYearBoundary]) {
      expect(selectTopicsForWeek(now)).toHaveLength(2);
    }
  });

  it('uses 2 evergreen pillars for a week with no awareness days', () => {
    const topics = selectTopicsForWeek(friday);
    expect(topics.map((topic) => topic.kind)).toEqual(['evergreen', 'evergreen']);
    expect(topics.every((topic) => topic.specialDay === undefined)).toBe(true);
  });

  it('mixes 1 special day with 1 evergreen pillar', () => {
    const topics = selectTopicsForWeek(mondayAugust);
    expect(topics.map((topic) => topic.kind)).toEqual(['special-day', 'evergreen']);
    expect(topics[0]!.specialDay).toBe('Hari Kemerdekaan Republik Indonesia');
  });

  it('uses 2 special days when the week has them', () => {
    const topics = selectTopicsForWeek(mondayDecember);
    expect(topics.map((topic) => topic.kind)).toEqual(['special-day', 'special-day']);
    expect(topics.map((topic) => topic.specialDay)).toEqual(['Hari Ibu', 'Hari Raya Natal']);
  });

  it('is deterministic for the same instant', () => {
    expect(selectTopicsForWeek(mondayDecember)).toEqual(selectTopicsForWeek(mondayDecember));
  });
});

describe('selectBonusAwarenessDayForWeek', () => {
  it('returns undefined for a week without awareness days', async () => {
    expect(await selectBonusAwarenessDayForWeek(friday)).toBeUndefined();
  });

  it('returns the first awareness day for the week', async () => {
    expect((await selectBonusAwarenessDayForWeek(mondayAugust))?.name).toBe('Hari Kemerdekaan Republik Indonesia');
    expect((await selectBonusAwarenessDayForWeek(mondayDecember))?.name).toBe('Hari Ibu');
  });

  it('keeps national holidays (e.g. Independence Day) eligible as a bonus', async () => {
    const bonus = await selectBonusAwarenessDayForWeek(mondayAugust);
    expect(bonus).toBeDefined();
    expect(bonus!.date).toBe('08-17');
    expect(bonus!.source).toBe('fixed');
  });

  it('resolves across the year boundary', async () => {
    expect((await selectBonusAwarenessDayForWeek(mondayYearBoundary))?.name).toBe('Tahun Baru Masehi');
  });

  it('prefers public-holiday-api entries over fixed-date entries on the same date', async () => {
    const now = new Date('2026-03-21T09:00:00+07:00'); // Friday of Idul Fitri week
    const apiHolidays = [
      { date: '2026-03-21', name: 'Hari Raya Idul Fitri', hijriYear: 1447, description: 'Hari Raya Idul Fitri 1447 Hijriyah' },
    ];
    const bonus = await selectBonusAwarenessDayForWeek(now, { publicHolidays: apiHolidays });
    expect(bonus).toBeDefined();
    expect(bonus!.name).toBe('Hari Raya Idul Fitri');
    expect(bonus!.hijriYear).toBe(1447);
    expect(bonus!.source).toBe('public-holiday-api');
  });

  it('returns the earliest date when both API and fixed sources have entries in the same week', async () => {
    const now = new Date('2026-12-21T09:00:00+07:00'); // week of Hari Ibu (12-22) and Natal (12-25)
    const apiHolidays = [
      { date: '2026-12-25', name: 'Hari Raya Natal' },
    ];
    const bonus = await selectBonusAwarenessDayForWeek(now, { publicHolidays: apiHolidays });
    expect(bonus!.name).toBe('Hari Ibu'); // 12-22 earlier than 12-25
    expect(bonus!.source).toBe('fixed');
  });

  it('falls back to fixed-date when publicHolidays is empty', async () => {
    const bonus = await selectBonusAwarenessDayForWeek(mondayAugust, { publicHolidays: [] });
    expect(bonus!.name).toBe('Hari Kemerdekaan Republik Indonesia');
    expect(bonus!.source).toBe('fixed');
  });
});

describe('SPECIAL_DAYS data integrity', () => {
  it('every entry has a well-formed MM-DD date', () => {
    for (const entry of SPECIAL_DAYS) {
      expect(MONTH_DAY_RE.test(entry.date)).toBe(true);
    }
  });

  it('has no duplicate dates', () => {
    const dates = SPECIAL_DAYS.map((entry) => entry.date);
    expect(new Set(dates).size).toBe(dates.length);
  });
});
