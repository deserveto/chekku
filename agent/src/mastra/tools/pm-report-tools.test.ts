import { describe, expect, it } from 'vitest';
import type { PmReportObjectStore } from '../pm-reports/store.js';
import { createListPmReportsFromGarageTool, createSavePmReportToGarageTool, createViewPmReportFromGarageTool } from './pm-report-tools.js';

const analysisMarkdown = `**Risk Rating: 8/10 — IN-DANGER**
**Headline:** Release is blocked.

## Summary
The report says "release is blocked", so launch cannot proceed.`;

function createMemoryStore() {
  const objects = new Map<string, string>();
  const store: PmReportObjectStore = {
    async ensureReady() {},
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
  return { store };
}

describe('PM report tools', () => {
  it('save/list/view PM report tools use Garage report storage', async () => {
    const { store } = createMemoryStore();
    const saveTool = createSavePmReportToGarageTool({ storeFactory: () => store, now: () => new Date('2026-07-13T12:00:00.000Z') });
    const listTool = createListPmReportsFromGarageTool({ storeFactory: () => store });
    const viewTool = createViewPmReportFromGarageTool({ storeFactory: () => store });

    const saved = await saveTool.execute?.({ reportMarkdown: 'Weekly report', analysisMarkdown, reportId: 'pmr_tool' }, {} as never) as { reportId: string; status: string; inputObjectKey: string };
    expect(saved?.reportId).toBe('pmr_tool');
    expect(saved?.status).toBe('IN-DANGER');
    expect(saved?.inputObjectKey).toBe('pm-reports/pmr_tool/input.md');

    const listed = await listTool.execute?.({}, {} as never) as { reports: Array<{ reportId: string }> };
    expect(listed?.reports[0]?.reportId).toBe('pmr_tool');

    const viewed = await viewTool.execute?.({ reportId: 'pmr_tool' }, {} as never) as { inputMarkdown: string; analysisMarkdown: string };
    expect(viewed?.inputMarkdown).toBe('Weekly report');
    expect(viewed?.analysisMarkdown).toBe(analysisMarkdown);
  });

  it('rejects analysis without risk header', async () => {
    const { store } = createMemoryStore();
    const saveTool = createSavePmReportToGarageTool({ storeFactory: () => store });

    await expect(saveTool.execute?.({ reportMarkdown: 'Weekly report', analysisMarkdown: 'No header', reportId: 'pmr_tool' }, {} as never))
      .rejects.toThrow(/missing a parseable risk rating header/);
  });
});
