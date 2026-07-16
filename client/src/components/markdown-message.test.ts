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
    const reportId = `pmr_render_${index}`;
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
    expect(html).toContain(`href="/reports/pmr_render_${index}"`);
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
