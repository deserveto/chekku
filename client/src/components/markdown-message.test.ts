import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

import { formatPmReportsMarkdown } from '../../../agent/src/mastra/tools/pm-report-tools.js';
import { MarkdownMessage } from './markdown-message.js';

it('renders only the generated report link from hostile report metadata', () => {
  const values = [
    'www.example.com',
    'https://example.com/path',
    'user@example.com',
    '![image](https://example.com/x.png)',
    '<b>unsafe</b>',
  ];
  const content = formatPmReportsMarkdown(values.map((createdAt, index) => {
    const reportId = `pmr_20260715112642_${index.toString(16).padStart(8, '0')}`;
    return {
      reportId,
      reportUrl: `/reports/${reportId}`,
      createdAt,
      rating: 4,
      status: 'WARNING' as const,
      inputObjectKey: `pm-reports/${reportId}/input.md`,
      analysisObjectKey: `pm-reports/${reportId}/analysis.md`,
      metadataObjectKey: `pm-reports/${reportId}/metadata.json`,
    };
  }));

  const html = renderToStaticMarkup(createElement(MarkdownMessage, { content }));
  const visiblyRenderedHtml = html.replace(/\u200b/g, '');

  expect(html.match(/<a /g)).toHaveLength(values.length);
  for (let index = 0; index < values.length; index += 1) {
    expect(html).toContain(`href="/reports/pmr_20260715112642_${index.toString(16).padStart(8, '0')}"`);
  }
  expect(html).not.toContain('href="http');
  expect(html).not.toContain('href="mailto:');
  expect(html).not.toContain('<img');
  expect(visiblyRenderedHtml).toContain('www.example.com');
  expect(visiblyRenderedHtml).toContain('https://example.com/path');
  expect(visiblyRenderedHtml).toContain('user@example.com');
  expect(visiblyRenderedHtml).toContain('![image](https://example.com/x.png)');
  expect(visiblyRenderedHtml).toContain('&lt;b&gt;unsafe&lt;/b&gt;');
});

it('renders report links as safe new-tab relative links', () => {
  const reportUrl = '/reports/pmr_20260714120000_a1b2c3d4';
  const markup = renderToStaticMarkup(createElement(MarkdownMessage, {
    content: `[report](${reportUrl})`,
  }));

  expect(markup).toContain(`<a href="${reportUrl}"`);
  expect(markup).toContain('target="_blank"');
  expect(markup).toContain('rel="noreferrer"');
  expect(markup).not.toContain('node="');
  expect(markup).toContain('>report</a>');
});

it('renders report tables in a labeled keyboard-scrollable region', () => {
  const content = [
    '| Report | Created | Risk | Status |',
    '| --- | --- | ---: | --- |',
    '| [pmr_20260715112642_deadbeef](/reports/pmr_20260715112642_deadbeef) | 2026-07-15 11:26 UTC | 8/10 | IN-DANGER |',
  ].join('\n');
  const markup = renderToStaticMarkup(createElement(MarkdownMessage, { content }));

  expect(markup).toContain('class="markdown-table-wrap"');
  expect(markup).toContain('tabindex="0"');
  expect(markup).toContain('role="region"');
  expect(markup).toContain('aria-label="Scrollable table"');
  expect(markup).toContain('<table>');
  expect(markup).toContain('href="/reports/pmr_20260715112642_deadbeef"');
  expect(markup).toContain('target="_blank"');
  expect(markup).toContain('rel="noreferrer"');
  expect(markup).toContain('>Risk</th>');
});

it('scopes responsive and focus styles to markdown tables', () => {
  const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
  const wrapperRule = css.match(/\.markdown-table-wrap\s*\{([^}]*)\}/)?.[1];
  const tableRule = css.match(/\.markdown-table-wrap table\s*\{([^}]*)\}/)?.[1];
  const cellRule = css.match(
    /\.markdown-table-wrap th,\s*\.markdown-table-wrap td\s*\{([^}]*)\}/,
  )?.[1];
  const thirdColumnRule = css.match(
    /\.markdown-table-wrap th:nth-child\(3\),\s*\.markdown-table-wrap td:nth-child\(3\)\s*\{([^}]*)\}/,
  )?.[1];
  const focusRule = css.match(/\.markdown-table-wrap:focus-visible\s*\{([^}]*)\}/)?.[1];

  expect(wrapperRule).toContain('overflow-x: auto');
  expect(tableRule).toContain('min-width: 600px');
  expect(cellRule).toContain('border-right: 1px solid var(--hairline)');
  expect(cellRule).toContain('border-bottom: 1px solid var(--hairline)');
  expect(cellRule).toContain('white-space: nowrap');
  expect(thirdColumnRule).toContain('text-align: right');
  expect(focusRule).toContain('outline: 1px solid var(--ink)');
  expect(focusRule).toContain('outline-offset: 2px');
});
