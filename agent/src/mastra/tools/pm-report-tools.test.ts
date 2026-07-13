import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createListPmReportsTool, createSavePmReportTool, createViewPmReportTool } from './pm-report-tools.js';

const analysisMarkdown = `**Risk Rating: 8/10 — IN-DANGER**
**Headline:** Release is blocked.

## Summary
The report says "release is blocked", so launch cannot proceed.`;

async function withTempStore<T>(fn: (baseDir: string) => Promise<T>) {
  const baseDir = await mkdtemp(join(tmpdir(), 'chekku-pm-report-tools-'));
  try {
    return await fn(baseDir);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
}

describe('PM report tools', () => {
  it('save/list/view PM report tools use local report storage', async () => {
    await withTempStore(async (baseDir) => {
      const saveTool = createSavePmReportTool({ baseDir, now: () => new Date('2026-07-13T12:00:00.000Z') });
      const listTool = createListPmReportsTool({ baseDir });
      const viewTool = createViewPmReportTool({ baseDir });

      const saved = await saveTool.execute?.({ reportMarkdown: 'Weekly report', analysisMarkdown, reportId: 'pmr_tool' }, {} as never) as { reportId: string; status: string };
      expect(saved?.reportId).toBe('pmr_tool');
      expect(saved?.status).toBe('IN-DANGER');

      const listed = await listTool.execute?.({}, {} as never) as { reports: Array<{ reportId: string }> };
      expect(listed?.reports[0]?.reportId).toBe('pmr_tool');

      const viewed = await viewTool.execute?.({ reportId: 'pmr_tool' }, {} as never) as { inputMarkdown: string; analysisMarkdown: string };
      expect(viewed?.inputMarkdown).toBe('Weekly report');
      expect(viewed?.analysisMarkdown).toBe(analysisMarkdown);
    });
  });
});
