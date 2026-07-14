import { describe, expect, it } from 'vitest';
import { getPmReport, listPmReports, parseRiskHeader, savePmReport, type PmReportObjectStore } from './store.js';

const analysisMarkdown = `**Risk Rating: 7/10 — WARNING**
**Headline:** Vendor credentials block integration.

## Summary
The report says "blocked by missing vendor credentials", so integration remains at risk.`;

function createMemoryStore() {
  const objects = new Map<string, string>();
  const store: PmReportObjectStore = {
    async putText(key, value) {
      objects.set(key, value);
    },
    async getText(key) {
      const value = objects.get(key);
      if (value === undefined) throw new Error(`Missing object: ${key}`);
      return value;
    },
    async listText(prefix) {
      return [...objects.entries()]
        .filter(([key]) => key.startsWith(prefix) && key.endsWith('/metadata.json'))
        .map(([, value]) => value);
    },
  };
  return { store, objects };
}

describe('PM report object store', () => {
  it('savePmReport writes input, analysis, and metadata objects', async () => {
    const { store, objects } = createMemoryStore();

    const metadata = await savePmReport({
        store,
        reportMarkdown: 'Weekly report body',
        analysisMarkdown,
        reportId: 'pmr_test_123',
        now: () => new Date('2026-07-13T12:00:00.000Z'),
      });

    expect(metadata).toEqual({
      reportId: 'pmr_test_123',
      createdAt: '2026-07-13T12:00:00.000Z',
      rating: 7,
      status: 'WARNING',
      inputObjectKey: 'pm-reports/pmr_test_123/input.md',
      analysisObjectKey: 'pm-reports/pmr_test_123/analysis.md',
      metadataObjectKey: 'pm-reports/pmr_test_123/metadata.json',
    });

    expect(objects.get('pm-reports/pmr_test_123/input.md')).toBe('Weekly report body');
    expect(objects.get('pm-reports/pmr_test_123/analysis.md')).toBe(analysisMarkdown);
    expect(JSON.parse(objects.get('pm-reports/pmr_test_123/metadata.json') ?? '{}')).toEqual(metadata);
  });

  it('listPmReports returns newest first', async () => {
    const { store } = createMemoryStore();
    await savePmReport({ store, reportMarkdown: 'Old', analysisMarkdown, reportId: 'pmr_old', now: () => new Date('2026-07-13T10:00:00.000Z') });
    await savePmReport({ store, reportMarkdown: 'New', analysisMarkdown, reportId: 'pmr_new', now: () => new Date('2026-07-13T11:00:00.000Z') });

    const reports = await listPmReports(store);
    expect(reports[0]?.reportId).toBe('pmr_new');
    expect(reports[1]?.reportId).toBe('pmr_old');
  });

  it('getPmReport reads saved input, analysis, and metadata', async () => {
    const { store } = createMemoryStore();
    const metadata = await savePmReport({ store, reportMarkdown: 'Report input', analysisMarkdown, reportId: 'pmr_view' });

    await expect(getPmReport(store, 'pmr_view')).resolves.toEqual({
      reportId: 'pmr_view',
      inputMarkdown: 'Report input',
      analysisMarkdown,
      metadata,
    });
  });

  it('parseRiskHeader rejects missing risk header', () => {
    expect(() => parseRiskHeader('No header')).toThrow(/missing a parseable risk rating header/);
  });
});
