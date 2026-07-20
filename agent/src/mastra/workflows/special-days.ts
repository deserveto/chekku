/**
 * Special-days topic selection for the weekly social drafts workflow.
 *
 * Stage 1 (no SearXNG research): the workflow derives the week's 2 content
 * topics from fixed-date awareness days that fall inside the current
 * Asia/Jakarta week (Mon–Sun). When a week has fewer than 2 special days, the
 * remaining slots are filled from a deterministic, week-indexed rotation of
 * evergreen content pillars, so the pipeline always emits exactly 2 topics.
 *
 * Movable feasts (Idul Fitri, Idul Adha, Imlek, Waisak, Paskah, Galungan, etc.)
 * are intentionally excluded: their Gregorian dates shift every year, and Stage
 * 1 requires deterministic, dependency-free topic selection. Stage 2 will
 * replace/augment this with SearXNG-driven trending topics.
 */

export const SOCIAL_TIMEZONE = 'Asia/Jakarta';

const MS_PER_DAY = 86_400_000;
const MS_PER_WEEK = 7 * MS_PER_DAY;

export interface SpecialDay {
  /** Fixed Gregorian date as 'MM-DD' (recurs annually). */
  date: string;
  name: string;
  /** Short content angle the drafter uses to frame the post. */
  angle: string;
}

export interface Pillar {
  id: string;
  name: string;
  angle: string;
}

export interface Topic {
  kind: 'special-day' | 'evergreen';
  name: string;
  angle: string;
  /** Present only when kind === 'special-day'; persisted as metadata.specialDay. */
  specialDay?: string;
}

/**
 * Curated, content-relevant fixed-date awareness days (Indonesian national +
 * internationally observed). Verified Gregorian dates only.
 */
export const SPECIAL_DAYS: readonly SpecialDay[] = [
  { date: '01-01', name: 'Tahun Baru Masehi', angle: 'Refleksi tahun baru, resolusi, atau ucapan selamat.' },
  { date: '02-04', name: 'Hari Kanker Sedunia', angle: 'Kesadaran pencegahan dan deteksi dini kanker.' },
  { date: '02-09', name: 'Hari Pers Nasional', angle: 'Peran pers bebas dan etika jurnalistik.' },
  { date: '03-08', name: 'Hari Perempuan Internasional', angle: 'Perayaan pencapaian perempuan dan kesetaraan gender.' },
  { date: '03-22', name: 'Hari Air Sedunia', angle: 'Pentingnya air bersih dan pelestarian sumber air.' },
  { date: '04-07', name: 'Hari Kesehatan Sedunia', angle: 'Edukasi kesehatan dan kebiasaan sehat.' },
  { date: '04-21', name: 'Hari Kartini', angle: 'Semangat emansipasi dan peran perempuan Indonesia.' },
  { date: '04-22', name: 'Hari Bumi', angle: 'Aksi lingkungan dan kepedulian terhadap bumi.' },
  { date: '05-01', name: 'Hari Buruh Internasional', angle: 'Penghargaan bagi pekerja dan hak-hak buruh.' },
  { date: '05-02', name: 'Hari Pendidikan Nasional', angle: 'Pentingnya pendidikan dan peran pendidik.' },
  { date: '05-20', name: 'Hari Kebangkitan Nasional', angle: 'Semangat perjuangan dan bangkitnya bangsa.' },
  { date: '06-01', name: 'Hari Lahir Pancasila', angle: 'Nilai-nilai Pancasila dalam kehidupan sehari-hari.' },
  { date: '07-23', name: 'Hari Anak Nasional', angle: 'Perlindungan, pendidikan, dan tumbuh kembang anak.' },
  { date: '08-17', name: 'Hari Kemerdekaan Republik Indonesia', angle: 'Semangat kemerdekaan dan kebanggaan nasional.' },
  { date: '09-08', name: 'Hari Aksara Internasional', angle: 'Pentingnya literasi dan minat baca.' },
  { date: '10-01', name: 'Hari Kesaktian Pancasila', angle: 'Refleksi nilai Pancasila sebagai dasar negara.' },
  { date: '10-02', name: 'Hari Batik Nasional', angle: 'Apresiasi warisan budaya batik Indonesia.' },
  { date: '10-10', name: 'Hari Kesehatan Jiwa Sedunia', angle: 'Kesehatan mental dan dukungan emosional.' },
  { date: '10-28', name: 'Hari Sumpah Pemuda', angle: 'Semangat pemuda dan persatuan bangsa.' },
  { date: '11-10', name: 'Hari Pahlawan', angle: 'Mengenang jasa pahlawan dan semangat patriotisme.' },
  { date: '11-25', name: 'Hari Guru Nasional', angle: 'Apresiasi dan peran guru dalam pendidikan.' },
  { date: '12-01', name: 'Hari AIDS Sedunia', angle: 'Kesadaran HIV/AIDS dan mengakhiri stigma.' },
  { date: '12-03', name: 'Hari Penyandang Disabilitas Internasional', angle: 'Inklusi dan kesetaraan hak penyandang disabilitas.' },
  { date: '12-10', name: 'Hari Hak Asasi Manusia Sedunia', angle: 'Kesetaraan hak dan martabat manusia.' },
  { date: '12-22', name: 'Hari Ibu', angle: 'Penghormatan dan peran ibu dalam keluarga.' },
  { date: '12-25', name: 'Hari Raya Natal', angle: 'Perayaan Natal dan semangat damai.' },
] as const;

/**
 * Evergreen content pillars used when a week has fewer than 2 special days.
 * Rotated deterministically by week index so consecutive weeks vary without
 * repeating, and the same week always resolves to the same pillars.
 */
export const EVERGREEN_PILLARS: readonly Pillar[] = [
  { id: 'tips', name: 'Tips & Trik', angle: 'Edukasi singkat dan praktis yang bermanfaat bagi audiens.' },
  { id: 'behind-the-scenes', name: 'Behind the Scenes', angle: 'Cuplikan proses kerja, tim, atau produksi.' },
  { id: 'brand-values', name: 'Nilai & Misi', angle: 'Nilai dan misi yang dijunjung brand.' },
  { id: 'community', name: 'Spotlight Komunitas', angle: 'Kisah atau suara audiens dan pelanggan.' },
  { id: 'inspiration', name: 'Inspirasi', angle: 'Kutipan atau pesan motivasi yang membangun.' },
  { id: 'product', name: 'Sorotan Produk', angle: 'Highlight produk/layanan dan manfaat utamanya.' },
] as const;

const MONTH_DAY_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Extract the calendar date (year, month, day) of `now` as observed in
 * `timeZone`, using Intl for the only step that genuinely needs timezone
 * awareness. The returned parts are pure Gregorian calendar values.
 */
function localDateParts(
  now: Date,
  timeZone: string,
): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(now);
  const lookup = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? NaN);
  return { year: lookup('year'), month: lookup('month'), day: lookup('day') };
}

/**
 * Monday (00:00 UTC of that Monday) of the week containing `now`, expressed as
 * a UTC millisecond timestamp plus the Monday's Gregorian calendar parts. The
 * weekday is computed in pure calendar math from the local date parts (a given
 * calendar date is the same weekday in every timezone), so only the y/m/d
 * extraction depends on the timezone.
 */
function mondayOf(
  now: Date,
  timeZone: string,
): { mondayMs: number; year: number; month: number; day: number } {
  const { year, month, day } = localDateParts(now, timeZone);
  const jsDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const dow = (jsDay + 6) % 7;
  const mondayMs = Date.UTC(year, month - 1, day - dow);
  const monday = new Date(mondayMs);
  return {
    mondayMs,
    year: monday.getUTCFullYear(),
    month: monday.getUTCMonth() + 1,
    day: monday.getUTCDate(),
  };
}

function monthDay(month: number, day: number): string {
  return `${pad2(month)}-${pad2(day)}`;
}

/**
 * The 7 'MM-DD' values for Mon–Sun of `now`'s week in `timeZone`. Jakarta
 * observes no DST, so day-stepping in UTC from the Monday midnight base is
 * unambiguous.
 */
export function weekDates(now: Date, timeZone: string = SOCIAL_TIMEZONE): string[] {
  const { mondayMs } = mondayOf(now, timeZone);
  return Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(mondayMs + offset * MS_PER_DAY);
    return monthDay(date.getUTCMonth() + 1, date.getUTCDate());
  });
}

/** 'YYYY-MM-DD' label of the Monday opening `now`'s week, for logs/metadata. */
export function weekStartLabel(now: Date, timeZone: string = SOCIAL_TIMEZONE): string {
  const { year, month, day } = mondayOf(now, timeZone);
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * Stable per-week integer. Consecutive Mondays differ by exactly one week, so
 * this value increments by 1 each week — suitable for deterministic rotation.
 */
function weekIndex(now: Date, timeZone: string): number {
  const { mondayMs } = mondayOf(now, timeZone);
  return Math.floor(mondayMs / MS_PER_WEEK);
}

/** Awareness days whose fixed date falls inside `now`'s week. */
export function specialDaysForWeek(now: Date, timeZone: string = SOCIAL_TIMEZONE): SpecialDay[] {
  const dates = new Set(weekDates(now, timeZone));
  return SPECIAL_DAYS.filter((entry) => {
    if (!MONTH_DAY_RE.test(entry.date)) return false;
    return dates.has(entry.date);
  });
}

/** `count` evergreen pillars rotated deterministically by week index. */
export function evergreenPillarsForWeek(
  now: Date,
  count: number,
  timeZone: string = SOCIAL_TIMEZONE,
): Pillar[] {
  const safeCount = Math.max(0, Math.floor(count));
  if (safeCount === 0) return [];
  const base = weekIndex(now, timeZone);
  const total = EVERGREEN_PILLARS.length;
  return Array.from({ length: safeCount }, (_, offset) => EVERGREEN_PILLARS[(base + offset) % total]!);
}

/**
 * Pure selection logic, decoupled from calendar math so it can be unit-tested
 * with constructed inputs. Always returns `count` topics: special days first,
 * then evergreen pillars to fill remaining slots.
 */
export function pickTopics(
  special: readonly SpecialDay[],
  pillars: readonly Pillar[],
  count = 2,
): Topic[] {
  const safeCount = Math.max(0, Math.floor(count));
  const topics: Topic[] = special.slice(0, safeCount).map((day) => ({
    kind: 'special-day',
    name: day.name,
    angle: day.angle,
    specialDay: day.name,
  }));
  for (const pillar of pillars) {
    if (topics.length >= safeCount) break;
    topics.push({ kind: 'evergreen', name: pillar.name, angle: pillar.angle });
  }
  return topics;
}

/**
 * Resolve exactly 2 content topics for `now`'s week: up to 2 awareness days,
 * filled out by evergreen pillars when the week has fewer than 2.
 */
export function selectTopicsForWeek(now: Date = new Date(), timeZone: string = SOCIAL_TIMEZONE): Topic[] {
  const special = specialDaysForWeek(now, timeZone);
  const pillars = evergreenPillarsForWeek(now, Math.max(0, 2 - special.length), timeZone);
  return pickTopics(special, pillars, 2);
}
