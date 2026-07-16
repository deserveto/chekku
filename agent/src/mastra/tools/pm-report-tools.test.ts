import type { ObjectStorage } from '@chekku/storage';
import { describe, expect, it } from 'vitest';

import {
  createListPmReportsFromGarageTool,
  createSavePmReportToGarageTool,
  createViewPmReportFromGarageTool,
  formatPmReportsMarkdown,
} from './pm-report-tools.js';

const analysisMarkdown = `**Risk Rating: 8/10 — IN-DANGER**
**Headline:** Release is blocked.

## Summary
The report says "release is blocked", so launch cannot proceed.`;
const markdownBreak = '&#8203;';

function createMemoryStore(): { objects: Map<string, string>; store: ObjectStorage } {
  const objects = new Map<string, string>();
  const store: ObjectStorage = {
    async ensureReady() {},
    async createText(key, value) {
      if (objects.has(key)) throw new Error('already exists');
      objects.set(key, value);
    },
    async replaceText(key, value) {
      if (!objects.has(key)) throw new Error('not found');
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
      if (!objects.delete(key)) throw new Error('not found');
    },
    async listKeys(prefix) {
      return {
        keys: [...objects.keys()].filter((key) => key.startsWith(prefix)).sort(),
        truncated: false,
      };
    },
  };
  return { objects, store };
}

const report = (reportId: string, createdAt: string, rating: number, status: 'ON-TRACK' | 'WARNING' | 'IN-DANGER') => ({
  reportId,
  reportUrl: `/reports/${encodeURIComponent(reportId)}`,
  createdAt,
  rating,
  status,
  inputObjectKey: `pm-reports/${reportId}/input.md`,
  analysisObjectKey: `pm-reports/${reportId}/analysis.md`,
  metadataObjectKey: `pm-reports/${reportId}/metadata.json`,
});

describe('PM report tools', () => {
  it('formats report lists as deterministic Markdown tables', () => {
    expect(formatPmReportsMarkdown([
      report('pmr_20260715112642_00000001', '2026-07-15T11:26:42.702Z', 8, 'IN-DANGER'),
      report('pmr_20260714112642_00000002', 'not|a\\date', 4, 'WARNING'),
    ])).toBe([
      '| Report | Created | Risk | Status |',
      '| --- | --- | ---: | --- |',
      '| [pmr_20260715112642_00000001](/reports/pmr_20260715112642_00000001) | 2026-07-15 11:26 UTC | 8/10 | IN-DANGER |',
      '| [pmr_20260714112642_00000002](/reports/pmr_20260714112642_00000002) | not\\|a\\\\date | 4/10 | WARNING |',
    ].join('\n'));
    expect(formatPmReportsMarkdown([])).toBe('No saved reports found.');
  });

  it.each([
    ['2026-07-15T11:26:42Z', '2026-07-15 11:26 UTC'],
    ['2026-07-15T11:26:42.123456789z', '2026-07-15 11:26 UTC'],
    ['2026-07-15t13:56:42+02:30', '2026-07-15 11:26 UTC'],
    ['2026-02-30T11:26:00.000Z', `2026\\-${markdownBreak}02\\-${markdownBreak}30T11\\:${markdownBreak}26\\:${markdownBreak}00\\.${markdownBreak}000Z`],
  ])('formats or safely preserves timestamp %s', (createdAt, expected) => {
    expect(formatPmReportsMarkdown([
      report('pmr_20260715112642_00000003', createdAt, 4, 'WARNING'),
    ])).toContain(` | ${expected} | 4/10 | WARNING |`);
  });

  it.each([
    ['www.example.com', `w${markdownBreak}ww\\.${markdownBreak}example\\.${markdownBreak}com`],
    ['https://example.com/path', `https\\:${markdownBreak}\\/${markdownBreak}\\/${markdownBreak}example\\.${markdownBreak}com\\/${markdownBreak}path`],
    ['user@example.com', `user\\@${markdownBreak}example\\.${markdownBreak}com`],
    ['![image](https://example.com/x.png)', `\\!${markdownBreak}\\[${markdownBreak}image\\]${markdownBreak}\\(${markdownBreak}https\\:${markdownBreak}\\/${markdownBreak}\\/${markdownBreak}example\\.${markdownBreak}com\\/${markdownBreak}x\\.${markdownBreak}png\\)${markdownBreak}`],
    ['<b>unsafe</b>', `\\<${markdownBreak}b\\>${markdownBreak}unsafe\\<${markdownBreak}\\/${markdownBreak}b\\>${markdownBreak}`],
  ])('escapes invalid timestamp %s without changing visible text', (createdAt, escaped) => {
    const markdown = formatPmReportsMarkdown([report('pmr_20260715112642_00000004', createdAt, 4, 'WARNING')]);

    expect(markdown).toContain(` | ${escaped} | 4/10 | WARNING |`);
  });

  it('escapes invalid timestamps against Markdown and control-character injection', () => {
    const createdAt = 'bad\r\n| [link](https://example.com) | ![image](https://example.com/x.png) | <b>\t\u0000';
    const markdown = formatPmReportsMarkdown([report('pmr_20260715112642_00000005', createdAt, 4, 'WARNING')]);

    expect(markdown.split('\n')).toHaveLength(3);
    expect(markdown).toContain('bad\\r\\n\\|');
    expect(markdown).toContain(`\\[${markdownBreak}link\\]${markdownBreak}\\(${markdownBreak}https\\:${markdownBreak}`);
    expect(markdown).toContain(`\\!${markdownBreak}\\[${markdownBreak}image\\]${markdownBreak}`);
    expect(markdown).toContain(`\\<${markdownBreak}b\\>${markdownBreak}\\t\\u0000`);
    expect(markdown).not.toContain('[link](');
    expect(markdown).not.toContain('![image](');
    expect(markdown).not.toContain('https://example.com');
    expect(markdown).not.toContain('<b>');
  });

  it('wraps every injected root store in the PM namespace and keeps presentation fields list-only', async () => {
    const { objects, store } = createMemoryStore();
    const saveTool = createSavePmReportToGarageTool({
      storeFactory: () => store,
      now: () => new Date('2026-07-13T12:00:00.000Z'),
    });
    const listTool = createListPmReportsFromGarageTool({ storeFactory: () => store });
    const viewTool = createViewPmReportFromGarageTool({ storeFactory: () => store });

    const saved = await saveTool.execute?.({
      reportMarkdown: 'Weekly report',
      analysisMarkdown,
    }, {} as never) as Record<string, unknown> & { reportId: string };
    expect(saved.reportId).toMatch(/^pmr_20260713120000_[a-f0-9]{8}$/);
    expect(saved).not.toHaveProperty('reportUrl');
    expect(saved).not.toHaveProperty('reportsMarkdown');

    const namespace = `agents/${Buffer.from('pm-agent').toString('base64url')}/`;
    expect([...objects.keys()]).toEqual(expect.arrayContaining([
      `${namespace}pm-reports/${saved.reportId}/input.md`,
      `${namespace}pm-reports/${saved.reportId}/analysis.md`,
      `${namespace}pm-reports/${saved.reportId}/metadata.json`,
    ]));
    const storedMetadata = objects.get(`${namespace}pm-reports/${saved.reportId}/metadata.json`)!;
    expect(JSON.parse(storedMetadata)).not.toHaveProperty('reportUrl');
    expect(JSON.parse(storedMetadata)).not.toHaveProperty('reportsMarkdown');

    const listed = await listTool.execute?.({}, {} as never) as {
      reports: Array<Record<string, unknown> & { reportId: string; reportUrl: string }>;
      reportsMarkdown: string;
    };
    expect(listed.reports[0]?.reportUrl).toBe(`/reports/${encodeURIComponent(saved.reportId)}`);
    expect(listed.reportsMarkdown).toContain(`[${saved.reportId}](/reports/${encodeURIComponent(saved.reportId)})`);

    const viewed = await viewTool.execute?.({ reportId: saved.reportId }, {} as never) as Record<string, unknown> & {
      metadata: Record<string, unknown>;
    };
    expect(viewed).not.toHaveProperty('reportUrl');
    expect(viewed).not.toHaveProperty('reportsMarkdown');
    expect(viewed.metadata).not.toHaveProperty('reportUrl');
    expect(viewed.metadata).not.toHaveProperty('reportsMarkdown');
  });

  it('uses strict public input and output schemas', async () => {
    const saveTool = createSavePmReportToGarageTool();
    const listTool = createListPmReportsFromGarageTool();
    const viewTool = createViewPmReportFromGarageTool();
    const metadata = {
      reportId: 'pmr_20260713120000_00000006',
      createdAt: '2026-07-13T12:00:00.000Z',
      rating: 8,
      status: 'IN-DANGER',
      inputObjectKey: 'pm-reports/pmr_20260713120000_00000006/input.md',
      analysisObjectKey: 'pm-reports/pmr_20260713120000_00000006/analysis.md',
      metadataObjectKey: 'pm-reports/pmr_20260713120000_00000006/metadata.json',
    };

    const validations = await Promise.all([
      saveTool.inputSchema!['~standard'].validate({ reportMarkdown: 'report', analysisMarkdown, reportId: 'pmr_override' }),
      listTool.inputSchema!['~standard'].validate({ unexpected: true }),
      viewTool.inputSchema!['~standard'].validate({ reportId: 'pmr_20260713120000_00000006', unexpected: true }),
      saveTool.outputSchema!['~standard'].validate({ ...metadata, unexpected: true }),
      listTool.outputSchema!['~standard'].validate({ reports: [], reportsMarkdown: '', unexpected: true }),
      viewTool.outputSchema!['~standard'].validate({
        reportId: metadata.reportId,
        inputMarkdown: '',
        analysisMarkdown: '',
        metadata,
        unexpected: true,
      }),
      viewTool.outputSchema!['~standard'].validate({
        reportId: metadata.reportId,
        inputMarkdown: '',
        analysisMarkdown: '',
        metadata: { ...metadata, unexpected: true },
      }),
    ]);

    for (const validation of validations) expect(validation.issues).toBeDefined();
  });

  it('rejects noncanonical report ids in view input', async () => {
    const viewTool = createViewPmReportFromGarageTool();

    const validation = await viewTool.inputSchema!['~standard'].validate({ reportId: 'pmr_legacy' });

    expect(validation.issues).toBeDefined();
  });

  it('rejects blank save inputs without trimming accepted values', async () => {
    const saveTool = createSavePmReportToGarageTool();
    const reportMarkdown = '  Weekly report\r\n';
    const paddedAnalysis = `\n${analysisMarkdown}\n  `;

    const accepted = await saveTool.inputSchema!['~standard'].validate({
      reportMarkdown,
      analysisMarkdown: paddedAnalysis,
    });
    const blankReport = await saveTool.inputSchema!['~standard'].validate({
      reportMarkdown: ' \r\n\t',
      analysisMarkdown,
    });
    const blankAnalysis = await saveTool.inputSchema!['~standard'].validate({
      reportMarkdown: 'Weekly report',
      analysisMarkdown: ' \r\n\t',
    });

    expect(accepted).toEqual({ value: { reportMarkdown, analysisMarkdown: paddedAnalysis } });
    expect(blankReport.issues).toBeDefined();
    expect(blankAnalysis.issues).toBeDefined();
  });

  it('persists accepted report and analysis whitespace unchanged', async () => {
    const { objects, store } = createMemoryStore();
    const reportMarkdown = '  Weekly report\r\n';
    const paddedAnalysis = `\n${analysisMarkdown}\n  `;
    const saveTool = createSavePmReportToGarageTool({
      storeFactory: () => store,
      now: () => new Date('2026-07-13T12:00:00.000Z'),
    });

    const saved = await saveTool.execute?.({
      reportMarkdown,
      analysisMarkdown: paddedAnalysis,
    }, {} as never) as { reportId: string };
    const namespace = `agents/${Buffer.from('pm-agent').toString('base64url')}`;

    expect(objects.get(`${namespace}/pm-reports/${saved.reportId}/input.md`)).toBe(reportMarkdown);
    expect(objects.get(`${namespace}/pm-reports/${saved.reportId}/analysis.md`)).toBe(paddedAnalysis);
  });

  it('rejects analysis without risk header', async () => {
    const { store } = createMemoryStore();
    const saveTool = createSavePmReportToGarageTool({ storeFactory: () => store });

    await expect(saveTool.execute?.({ reportMarkdown: 'Weekly report', analysisMarkdown: 'No header' }, {} as never))
      .rejects.toThrow(/missing a parseable risk rating header/);
  });
});
