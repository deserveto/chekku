import type { CompetitiveAnalysisMetadata, ObjectStorage } from '@chekku/storage';
import { describe, expect, it } from 'vitest';

import {
  createListCompetitiveAnalysesFromGarageTool,
  createSaveCompetitiveAnalysisToGarageTool,
  createViewCompetitiveAnalysisFromGarageTool,
  formatCompetitiveAnalysesMarkdown,
} from './competitive-analysis-tools.js';

const analysisId = 'pca_20260723120000_deadbeef';
const analysisMarkdown = [
  '# Competitive Analysis: GPT',
  '## Executive Summary',
  'GPT leads the compared set in the evidenced focus area.',
  '## Scope and Competitor Selection',
  'Anchor plus five competitors.',
  '## Product Profiles',
  '### GPT',
  'Primary source: https://openai.com/chatgpt/',
  '## Feature Matrix',
  '| Feature | GPT |',
  '| --- | --- |',
  '| Chat | [Yes](https://openai.com/chatgpt/) |',
  '## Gaps and Opportunities',
  'Evidence-backed opportunity.',
  '## Risks and Confidence',
  'Public evidence may change.',
  '## Recommendations',
  '1. Validate the highest-value gap.',
  '## Sources',
  '- GPT: https://openai.com/chatgpt/',
].join('\n\n');
const competitorNames = ['Claude', 'Gemini', 'Copilot', 'Perplexity', 'Meta AI'];
const sources = [
  { productName: 'GPT', url: 'https://openai.com/chatgpt/' },
  { productName: 'Claude', url: 'https://www.anthropic.com/claude' },
  { productName: 'Gemini', url: 'https://gemini.google.com/' },
  { productName: 'Copilot', url: 'https://www.microsoft.com/copilot' },
  { productName: 'Perplexity', url: 'https://www.perplexity.ai/' },
  { productName: 'Meta AI', url: 'https://www.meta.ai/' },
];

const saveInput = {
  requestMarkdown: '/competitive-analysis GPT vs Claude',
  analysisMarkdown,
  anchorProduct: ' GPT ',
  market: ' AI assistants ',
  competitorNames,
  sources,
};

function createMemoryStore(): {
  objects: Map<string, string>;
  store: ObjectStorage;
  readyCalls: () => number;
} {
  const objects = new Map<string, string>();
  let readyCallCount = 0;
  const store: ObjectStorage = {
    async ensureReady() {
      readyCallCount += 1;
    },
    async createText(key, value) {
      if (objects.has(key)) throw new Error(`Already exists: ${key}`);
      objects.set(key, value);
    },
    async replaceText(key, value) {
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
    async listKeys(prefix) {
      return {
        keys: [...objects.keys()].filter((key) => key.startsWith(prefix)).sort(),
        truncated: false,
      };
    },
  };
  return { objects, store, readyCalls: () => readyCallCount };
}

function metadata(overrides: Partial<CompetitiveAnalysisMetadata> = {}): CompetitiveAnalysisMetadata {
  return {
    analysisId,
    createdAt: '2026-07-23T12:00:00.000Z',
    anchorProduct: 'GPT',
    market: 'AI assistants',
    competitorNames,
    productCount: 6,
    sourceCount: 6,
    requestObjectKey: `competitive-analyses/${analysisId}/request.md`,
    analysisObjectKey: `competitive-analyses/${analysisId}/analysis.md`,
    metadataObjectKey: `competitive-analyses/${analysisId}/metadata.json`,
    ...overrides,
  };
}

async function validateInput(
  tool: ReturnType<typeof createSaveCompetitiveAnalysisToGarageTool>,
  input: unknown,
) {
  return tool.inputSchema!['~standard'].validate(input);
}

describe('competitive analysis tools', () => {
  it('uses exact PM-only tool IDs', () => {
    expect(createSaveCompetitiveAnalysisToGarageTool().id).toBe('save_competitive_analysis_to_garage');
    expect(createListCompetitiveAnalysesFromGarageTool().id).toBe('list_competitive_analyses_from_garage');
    expect(createViewCompetitiveAnalysisFromGarageTool().id).toBe('view_competitive_analysis_from_garage');
  });

  it('formats deterministic competitive analysis list Markdown', () => {
    expect(formatCompetitiveAnalysesMarkdown([{
      ...metadata(),
      analysisUrl: `/reports/competitive/${analysisId}`,
    }])).toBe([
      '| Analysis | Created | Anchor | Competitors | Sources |',
      '| --- | --- | --- | ---: | ---: |',
      `| [${analysisId}](/reports/competitive/${analysisId}) | 2026-07-23 12:00 UTC | GPT | 5 | 6 |`,
    ].join('\n'));
    expect(formatCompetitiveAnalysesMarkdown([])).toBe('No saved competitive analyses found.');
  });

  it('escapes hostile anchor and invalid timestamp cells without adding rows or links', () => {
    const markdown = formatCompetitiveAnalysesMarkdown([{
      ...metadata({
        createdAt: 'bad\r\n| [link](https://example.com)',
        anchorProduct: '<b>www.attacker.example</b>\t',
      }),
      analysisUrl: `/reports/competitive/${analysisId}`,
    }]);

    expect(markdown.split('\n')).toHaveLength(3);
    expect(markdown).toContain('bad\\r\\n\\|');
    expect(markdown).toContain('\\<&#8203;b\\>&#8203;');
    expect(markdown).toContain('w&#8203;ww\\.&#8203;attacker\\.&#8203;example');
    expect(markdown).not.toContain('[link](');
    expect(markdown).not.toContain('<b>');
    expect(markdown).not.toContain('https://example.com');
  });

  it('saves normalized complete analyses under the fixed PM namespace', async () => {
    const { objects, store, readyCalls } = createMemoryStore();
    const saveTool = createSaveCompetitiveAnalysisToGarageTool({
      storeFactory: () => store,
      now: () => new Date('2026-07-23T12:00:00.000Z'),
    });

    const saved = await saveTool.execute?.(saveInput, {} as never) as Record<string, unknown> & {
      analysisId: string;
    };

    expect(saved).toMatchObject({
      anchorProduct: 'GPT',
      market: 'AI assistants',
      competitorNames,
      productCount: 6,
      sourceCount: 6,
    });
    expect(saved.analysisId).toMatch(/^pca_20260723120000_[0-9a-f]{8}$/);
    expect(readyCalls()).toBe(1);
    expect(saved).not.toHaveProperty('analysisUrl');
    expect(saved).not.toHaveProperty('analysesMarkdown');

    const namespace = `agents/${Buffer.from('pm-agent').toString('base64url')}`;
    const base = `${namespace}/competitive-analyses/${saved.analysisId}`;
    expect(objects.get(`${base}/request.md`)).toBe(saveInput.requestMarkdown);
    expect(objects.get(`${base}/analysis.md`)).toBe(saveInput.analysisMarkdown);
    const storedMetadata = JSON.parse(objects.get(`${base}/metadata.json`)!);
    expect(storedMetadata).toMatchObject({ productCount: 6, sourceCount: 6 });
    expect(storedMetadata).not.toHaveProperty('sources');
    expect(storedMetadata).not.toHaveProperty('analysisUrl');
    expect(storedMetadata).not.toHaveProperty('analysesMarkdown');
  });

  it('normalizes source URLs and product spellings before save validation', async () => {
    const { store } = createMemoryStore();
    const tool = createSaveCompetitiveAnalysisToGarageTool({
      storeFactory: () => store,
      now: () => new Date('2026-07-23T12:00:00.000Z'),
    });

    const saved = await tool.execute?.({
      ...saveInput,
      competitorNames: competitorNames.map((name) => ` ${name} `),
      sources: sources.map((source) => ({
        productName: ` ${source.productName.toUpperCase()} `,
        url: ` ${source.url} `,
      })),
    }, {} as never) as CompetitiveAnalysisMetadata;

    expect(saved.anchorProduct).toBe('GPT');
    expect(saved.competitorNames).toEqual(competitorNames);
  });

  it('lists newest analyses with URL and Markdown fields only in list output', async () => {
    const { store } = createMemoryStore();
    const firstSave = createSaveCompetitiveAnalysisToGarageTool({
      storeFactory: () => store,
      now: () => new Date('2026-07-23T11:00:00.000Z'),
    });
    const secondSave = createSaveCompetitiveAnalysisToGarageTool({
      storeFactory: () => store,
      now: () => new Date('2026-07-23T12:00:00.000Z'),
    });
    const old = await firstSave.execute?.(saveInput, {} as never) as CompetitiveAnalysisMetadata;
    const recent = await secondSave.execute?.(
      {
        ...saveInput,
        anchorProduct: 'ChatGPT',
        sources: sources.map((source, index) =>
          index === 0 ? { ...source, productName: 'ChatGPT' } : source),
      },
      {} as never,
    ) as CompetitiveAnalysisMetadata;

    const listed = await createListCompetitiveAnalysesFromGarageTool({ storeFactory: () => store })
      .execute?.({}, {} as never) as {
        analyses: Array<CompetitiveAnalysisMetadata & { analysisUrl: string }>;
        analysesMarkdown: string;
      };

    expect(listed.analyses.map(({ analysisId: id }) => id)).toEqual([
      recent.analysisId,
      old.analysisId,
    ]);
    expect(listed.analyses[0]?.analysisUrl).toBe(
      `/reports/competitive/${encodeURIComponent(recent.analysisId)}`,
    );
    expect(listed.analysesMarkdown).toContain(
      `[${recent.analysisId}](/reports/competitive/${encodeURIComponent(recent.analysisId)})`,
    );
    expect(listed.analysesMarkdown).toContain(' | ChatGPT | 5 | 6 |');
  });

  it('views request, analysis, and projected metadata without presentation fields', async () => {
    const { store } = createMemoryStore();
    const saved = await createSaveCompetitiveAnalysisToGarageTool({
      storeFactory: () => store,
      now: () => new Date('2026-07-23T12:00:00.000Z'),
    }).execute?.(saveInput, {} as never) as CompetitiveAnalysisMetadata;

    const viewed = await createViewCompetitiveAnalysisFromGarageTool({ storeFactory: () => store })
      .execute?.({ analysisId: saved.analysisId }, {} as never) as Record<string, unknown> & {
        metadata: Record<string, unknown>;
      };

    expect(viewed).toMatchObject({
      analysisId: saved.analysisId,
      requestMarkdown: saveInput.requestMarkdown,
      analysisMarkdown: saveInput.analysisMarkdown,
    });
    expect(viewed).not.toHaveProperty('analysisUrl');
    expect(viewed).not.toHaveProperty('analysesMarkdown');
    expect(viewed.metadata).not.toHaveProperty('analysisUrl');
    expect(viewed.metadata).not.toHaveProperty('analysesMarkdown');
  });

  it('uses strict public input and output schemas', async () => {
    const saveTool = createSaveCompetitiveAnalysisToGarageTool();
    const listTool = createListCompetitiveAnalysesFromGarageTool();
    const viewTool = createViewCompetitiveAnalysisFromGarageTool();
    const approvedMetadata = metadata();

    const validations = await Promise.all([
      saveTool.inputSchema!['~standard'].validate({ ...saveInput, unexpected: true }),
      listTool.inputSchema!['~standard'].validate({ unexpected: true }),
      viewTool.inputSchema!['~standard'].validate({ analysisId, unexpected: true }),
      saveTool.outputSchema!['~standard'].validate({ ...approvedMetadata, unexpected: true }),
      listTool.outputSchema!['~standard'].validate({ analyses: [], analysesMarkdown: '', unexpected: true }),
      viewTool.outputSchema!['~standard'].validate({
        analysisId,
        requestMarkdown: saveInput.requestMarkdown,
        analysisMarkdown,
        metadata: approvedMetadata,
        unexpected: true,
      }),
      viewTool.outputSchema!['~standard'].validate({
        analysisId,
        requestMarkdown: saveInput.requestMarkdown,
        analysisMarkdown,
        metadata: { ...approvedMetadata, unexpected: true },
      }),
    ]);

    for (const validation of validations) expect(validation.issues).toBeDefined();
  });

  it.each([
    ['blank request', { requestMarkdown: ' \r\n\t' }],
    ['blank analysis', { analysisMarkdown: ' \r\n\t' }],
    ['oversized request', { requestMarkdown: 'r'.repeat(262_145) }],
    ['oversized analysis', { analysisMarkdown: 'a'.repeat(262_145) }],
    ['four competitors', { competitorNames: competitorNames.slice(0, 4) }],
    ['eight competitors', { competitorNames: [...competitorNames, 'A', 'B', 'C'] }],
    ['duplicate anchor', { competitorNames: ['gpt', ...competitorNames.slice(1)] }],
    ['duplicate competitor', { competitorNames: ['Claude', 'claude', ...competitorNames.slice(2)] }],
    ['missing source', { sources: sources.slice(0, 5) }],
    ['extra source', { sources: [...sources, { productName: 'Extra', url: 'https://example.com/' }] }],
    ['duplicate source product', { sources: sources.map((source, index) =>
      index === 1 ? { ...source, productName: 'GPT' } : source) }],
    ['duplicate normalized URL', { sources: sources.map((source, index) =>
      index === 1 ? { ...source, url: 'HTTPS://OPENAI.COM:443/chatgpt/' } : source) }],
    ['source name mismatch', { sources: sources.map((source, index) =>
      index === 1 ? { ...source, productName: 'Anthropic' } : source) }],
    ['private URL', { sources: sources.map((source, index) =>
      index === 1 ? { ...source, url: 'http://127.0.0.1/' } : source) }],
    ['local URL', { sources: sources.map((source, index) =>
      index === 1 ? { ...source, url: 'http://localhost/' } : source) }],
    ['non-HTTP URL', { sources: sources.map((source, index) =>
      index === 1 ? { ...source, url: 'ftp://example.com/' } : source) }],
    ['oversized URL', { sources: sources.map((source, index) =>
      index === 1 ? { ...source, url: `https://example.com/${'a'.repeat(2_100)}` } : source) }],
  ])('rejects incomplete or unsafe save input: %s', async (_name, override) => {
    const validation = await validateInput(
      createSaveCompetitiveAnalysisToGarageTool(),
      { ...saveInput, ...override },
    );

    expect(validation.issues).toBeDefined();
  });

  it('rejects noncanonical analysis IDs in view input', async () => {
    const validation = await createViewCompetitiveAnalysisFromGarageTool()
      .inputSchema!['~standard'].validate({ analysisId: 'pca_legacy' });

    expect(validation.issues).toBeDefined();
  });
});
