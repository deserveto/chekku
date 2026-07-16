import { describe, expect, it } from 'vitest';

import { createNamespacedObjectStorage } from './namespaced-objects.ts';
import type { ObjectStorage } from './objects.ts';
import {
  PM_REPORT_AGENT_ID,
  createPmReportStorage,
  getPmReport,
  keysFor,
  listPmReports,
  parsePmReportTimestamp,
  parseRiskHeader,
  savePmReport,
} from './pm-reports.ts';

const analysisMarkdown = `**Risk Rating: 7/10 - WARNING**
**Headline:** Vendor credentials block integration.`;

function createMemoryStorage() {
  const objects = new Map<string, string>();
  const writes: Array<{ method: 'create' | 'replace'; key: string; value: string; contentType?: string }> = [];
  const storage: ObjectStorage = {
    async createText(key, value, contentType) {
      if (objects.has(key)) throw new Error(`Already exists: ${key}`);
      writes.push({ method: 'create', key, value, contentType });
      objects.set(key, value);
    },
    async replaceText(key, value, contentType) {
      writes.push({ method: 'replace', key, value, contentType });
      objects.set(key, value);
    },
    async getText(key) {
      const value = objects.get(key);
      if (value === undefined) throw new Error(`Missing object: ${key}`);
      return value;
    },
    async exists(key) {
      return objects.has(key);
    },
    async delete(key) {
      objects.delete(key);
    },
    async listKeys(prefix, options) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix));
      const limit = options?.limit ?? keys.length;
      return { keys: keys.slice(0, limit), truncated: keys.length > limit };
    },
  };
  return { objects, storage, writes };
}

describe('PM report storage', () => {
  it('uses the PM agent namespace and exposes relative metadata keys', async () => {
    const { objects, storage } = createMemoryStorage();
    const store = createPmReportStorage(storage);

    const metadata = await savePmReport({
      store,
      reportMarkdown: 'Weekly report body',
      analysisMarkdown,
      reportId: 'pmr_test_123',
      now: () => new Date('2026-07-13T12:00:00.000Z'),
    });

    expect(PM_REPORT_AGENT_ID).toBe('pm-agent');
    expect([...objects.keys()]).toContain(
      `agents/${Buffer.from('pm-agent').toString('base64url')}/pm-reports/pmr_test_123/metadata.json`,
    );
    expect(metadata.metadataObjectKey).toBe('pm-reports/pmr_test_123/metadata.json');
  });

  it('writes input and analysis before metadata using createText', async () => {
    const { storage, writes } = createMemoryStorage();

    const metadata = await savePmReport({
      store: storage,
      reportMarkdown: 'Weekly report body',
      analysisMarkdown,
      reportId: 'pmr_test_123',
      now: () => new Date('2026-07-13T12:00:00.000Z'),
    });

    expect(writes).toEqual([
      { method: 'create', key: 'pm-reports/pmr_test_123/input.md', value: 'Weekly report body', contentType: 'text/markdown' },
      { method: 'create', key: 'pm-reports/pmr_test_123/analysis.md', value: analysisMarkdown, contentType: 'text/markdown' },
      { method: 'create', key: 'pm-reports/pmr_test_123/metadata.json', value: JSON.stringify(metadata, null, 2), contentType: 'application/json' },
    ]);
  });

  it('does not list a partial save without metadata', async () => {
    const { storage } = createMemoryStorage();
    await storage.createText('pm-reports/pmr_partial/input.md', 'input');
    await storage.createText('pm-reports/pmr_partial/analysis.md', analysisMarkdown);

    await expect(listPmReports(storage)).resolves.toEqual([]);
  });

  it.each([
    ['analysis.md', ['pm-reports/pmr_partial/input.md']],
    ['metadata.json', ['pm-reports/pmr_partial/input.md', 'pm-reports/pmr_partial/analysis.md']],
  ])('propagates %s create failures without exposing a completed report', async (failedObject, persistedKeys) => {
    const { objects, storage } = createMemoryStorage();
    const failingStorage: ObjectStorage = {
      ...storage,
      async createText(key, value, contentType) {
        if (key.endsWith(`/${failedObject}`)) throw new Error(`Injected ${failedObject} failure`);
        await storage.createText(key, value, contentType);
      },
    };

    await expect(savePmReport({
      store: failingStorage,
      reportMarkdown: 'Report input',
      analysisMarkdown,
      reportId: 'pmr_partial',
    })).rejects.toThrow(`Injected ${failedObject} failure`);
    expect([...objects.keys()]).toEqual(persistedKeys);
    expect(objects.has('pm-reports/pmr_partial/metadata.json')).toBe(false);
    await expect(listPmReports(storage)).resolves.toEqual([]);
  });

  it('isolates PM reports from another agent namespace', async () => {
    const { storage } = createMemoryStorage();
    const pmStore = createPmReportStorage(storage);
    const foreignStore = createNamespacedObjectStorage(storage, 'other-agent');
    await savePmReport({ store: pmStore, reportMarkdown: 'PM', analysisMarkdown, reportId: 'pmr_pm' });
    await savePmReport({ store: foreignStore, reportMarkdown: 'Foreign', analysisMarkdown, reportId: 'pmr_foreign' });

    await expect(listPmReports(pmStore)).resolves.toMatchObject([{ reportId: 'pmr_pm' }]);
    await expect(getPmReport(pmStore, 'pmr_foreign')).rejects.toThrow('Missing object');
  });

  it('lists report metadata newest first', async () => {
    const { storage } = createMemoryStorage();
    await savePmReport({ store: storage, reportMarkdown: 'Old', analysisMarkdown, reportId: 'pmr_old', now: () => new Date('2026-07-13T10:00:00.000Z') });
    await savePmReport({ store: storage, reportMarkdown: 'New', analysisMarkdown, reportId: 'pmr_new', now: () => new Date('2026-07-13T11:00:00.000Z') });

    expect((await listPmReports(storage)).map((report) => report.reportId)).toEqual(['pmr_new', 'pmr_old']);
  });

  it('rejects truncated object listings instead of returning an incomplete report list', async () => {
    const { storage } = createMemoryStorage();
    const truncatedStorage: ObjectStorage = {
      ...storage,
      async listKeys() {
        return { keys: [], truncated: true };
      },
    };

    await expect(listPmReports(truncatedStorage)).rejects.toThrow(
      'Cannot list all PM reports: object storage truncated the pm-reports/ listing. Increase the storage listing limit.',
    );
  });

  it.each([
    ['2026-07-15T11:26:42.7Z', Date.UTC(2026, 6, 15, 11, 26, 42, 700)],
    ['2026-07-15T11:26:42.123456789z', Date.UTC(2026, 6, 15, 11, 26, 42, 123)],
    ['2026-07-15t11:26:42z', Date.UTC(2026, 6, 15, 11, 26, 42)],
    ['2026-07-15t13:56:42.987654321+02:30', Date.UTC(2026, 6, 15, 11, 26, 42, 987)],
    ['2026-07-15T06:26:42-05:00', Date.UTC(2026, 6, 15, 11, 26, 42)],
  ])('parses timestamp %s and truncates fractions to milliseconds', (createdAt, expected) => {
    expect(parsePmReportTimestamp(createdAt)).toBe(expected);
  });

  it.each([
    '2026-02-30T11:26:42.123456Z',
    '2025-02-29t11:26:42.123456z',
    '2026-13-01T00:00:00Z',
    '2026-07-15T13:56:42+0230',
  ])('rejects invalid RFC3339 timestamp %s', (createdAt) => {
    expect(parsePmReportTimestamp(createdAt)).toBeUndefined();
  });

  it('sorts valid timestamps first and retains source order for invalid or equal instants', async () => {
    const { objects, storage } = createMemoryStorage();
    const metadata = (reportId: string, createdAt: string) => ({
      reportId,
      createdAt,
      rating: 4,
      status: 'WARNING',
      ...keysFor(reportId),
    });
    objects.set('pm-reports/pmr_invalid_calendar/metadata.json', JSON.stringify(metadata('pmr_invalid_calendar', '2026-02-30T11:26:00.000Z')));
    objects.set('pm-reports/pmr_equal_first/metadata.json', JSON.stringify(metadata('pmr_equal_first', '2026-07-15T11:26:42.1239Z')));
    objects.set('pm-reports/pmr_invalid_text/metadata.json', JSON.stringify(metadata('pmr_invalid_text', 'not a date')));
    objects.set('pm-reports/pmr_equal_second/metadata.json', JSON.stringify(metadata('pmr_equal_second', '2026-07-15T11:26:42.1231Z')));

    expect((await listPmReports(storage)).map((report) => [report.reportId, report.createdAt])).toEqual([
      ['pmr_equal_first', '2026-07-15T11:26:42.1239Z'],
      ['pmr_equal_second', '2026-07-15T11:26:42.1231Z'],
      ['pmr_invalid_calendar', '2026-02-30T11:26:00.000Z'],
      ['pmr_invalid_text', 'not a date'],
    ]);
  });

  it.each([
    [1, 'ON-TRACK'],
    [3, 'ON-TRACK'],
    [4, 'WARNING'],
    [7, 'WARNING'],
    [8, 'IN-DANGER'],
    [10, 'IN-DANGER'],
  ] as const)('maps risk rating %i to %s', (rating, status) => {
    expect(parseRiskHeader(`Risk Rating: ${rating}/10 - ${status}`)).toEqual({ rating, status });
  });

  it('rejects missing or inconsistent risk headers', () => {
    expect(() => parseRiskHeader('No header')).toThrow(/missing a parseable risk rating header/);
    expect(() => parseRiskHeader('Risk Rating: 3/10 - WARNING')).toThrow(
      'Risk rating 3 requires status ON-TRACK, received WARNING',
    );
  });

  it.each([
    'Risk Rating: 3/10 - ON-TRACKED',
    'Risk Rating: 4/10 - WARNING-extra',
    'Risk Rating: 8/10 - IN-DANGER later',
  ])('rejects risk status with trailing content: %s', (header) => {
    expect(() => parseRiskHeader(header)).toThrow(/missing a parseable risk rating header/);
  });

  it('skips malformed metadata but retains otherwise valid invalid createdAt strings', async () => {
    const { objects, storage } = createMemoryStorage();
    const valid = { reportId: 'pmr_valid', createdAt: 'invalid date', rating: 4, status: 'WARNING', ...keysFor('pmr_valid') };
    objects.set('pm-reports/pmr_valid/metadata.json', JSON.stringify(valid));
    objects.set('pm-reports/pmr_corrupt/metadata.json', '{not-json');
    objects.set('pm-reports/pmr_bad_id/metadata.json', JSON.stringify({ ...valid, reportId: 'bad_id' }));
    objects.set('pm-reports/pmr_bad_key/metadata.json', JSON.stringify({ ...valid, reportId: 'pmr_bad_key' }));
    objects.set('pm-reports/pmr_bad_rating/metadata.json', JSON.stringify({ ...valid, reportId: 'pmr_bad_rating', rating: 11, ...keysFor('pmr_bad_rating') }));
    objects.set('pm-reports/pmr_bad_status/metadata.json', JSON.stringify({ ...valid, reportId: 'pmr_bad_status', status: 'ON-TRACK', ...keysFor('pmr_bad_status') }));

    await expect(listPmReports(storage)).resolves.toEqual([valid]);
  });

  it('propagates metadata read failures while safely rejecting invalid read metadata', async () => {
    const { objects, storage } = createMemoryStorage();
    await savePmReport({ store: storage, reportMarkdown: 'Report input', analysisMarkdown, reportId: 'pmr_view' });
    const failingStorage: ObjectStorage = { ...storage, async getText() { throw new Error('Garage access denied'); } };
    await expect(listPmReports(failingStorage)).rejects.toThrow('Garage access denied');

    objects.set('pm-reports/pmr_view/metadata.json', JSON.stringify({ reportId: 'pmr_view' }));
    await expect(getPmReport(storage, 'pmr_view')).rejects.toThrow('Invalid PM report metadata for pmr_view');
  });

  it('reads a saved report', async () => {
    const { storage } = createMemoryStorage();
    const metadata = await savePmReport({ store: storage, reportMarkdown: 'Report input', analysisMarkdown, reportId: 'pmr_view' });

    await expect(getPmReport(storage, 'pmr_view')).resolves.toEqual({
      reportId: 'pmr_view',
      inputMarkdown: 'Report input',
      analysisMarkdown,
      metadata,
    });
  });

  it.each(['../escape', 'pmr_bad/id', 'report', 'pmr_'])('rejects invalid report id %s at every boundary', async (reportId) => {
    const { storage, writes } = createMemoryStorage();
    expect(() => keysFor(reportId)).toThrow(`Invalid PM report id: ${reportId}`);
    await expect(savePmReport({ store: storage, reportMarkdown: 'Report', analysisMarkdown, reportId })).rejects.toThrow(`Invalid PM report id: ${reportId}`);
    await expect(getPmReport(storage, reportId)).rejects.toThrow(`Invalid PM report id: ${reportId}`);
    expect(writes).toEqual([]);
  });
});
