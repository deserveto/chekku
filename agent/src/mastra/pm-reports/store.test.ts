import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getPmReport, listPmReports, parseRiskHeader, savePmReport } from './store.js';

const analysisMarkdown = `**Risk Rating: 7/10 — WARNING**
**Headline:** Vendor credentials block integration.

## Summary
The report says "blocked by missing vendor credentials", so integration remains at risk.`;

async function withTempStore<T>(fn: (baseDir: string) => Promise<T>) {
  const baseDir = await mkdtemp(join(tmpdir(), 'chekku-pm-reports-'));
  try {
    return await fn(baseDir);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
}

describe('PM report local store', () => {
  it('savePmReport writes input, analysis, and metadata', async () => {
    await withTempStore(async (baseDir) => {
      const metadata = await savePmReport({
        baseDir,
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
        inputPath: join(baseDir, 'pmr_test_123', 'input.md'),
        analysisPath: join(baseDir, 'pmr_test_123', 'analysis.md'),
        metadataPath: join(baseDir, 'pmr_test_123', 'metadata.json'),
      });
    });
  });

  it('listPmReports returns newest first', async () => {
    await withTempStore(async (baseDir) => {
      await savePmReport({ baseDir, reportMarkdown: 'Old', analysisMarkdown, reportId: 'pmr_old', now: () => new Date('2026-07-13T10:00:00.000Z') });
      await savePmReport({ baseDir, reportMarkdown: 'New', analysisMarkdown, reportId: 'pmr_new', now: () => new Date('2026-07-13T11:00:00.000Z') });

      const reports = await listPmReports(baseDir);
      expect(reports[0]?.reportId).toBe('pmr_new');
      expect(reports[1]?.reportId).toBe('pmr_old');
    });
  });

  it('getPmReport reads saved input, analysis, and metadata', async () => {
    await withTempStore(async (baseDir) => {
      const metadata = await savePmReport({ baseDir, reportMarkdown: 'Report input', analysisMarkdown, reportId: 'pmr_view' });

      await expect(getPmReport(baseDir, 'pmr_view')).resolves.toEqual({
        reportId: 'pmr_view',
        inputMarkdown: 'Report input',
        analysisMarkdown,
        metadata,
      });
    });
  });

  it('parseRiskHeader rejects missing risk header', () => {
    expect(() => parseRiskHeader('No header')).toThrow(/missing a parseable risk rating header/);
  });
});
