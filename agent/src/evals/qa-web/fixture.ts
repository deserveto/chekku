import { createServer, type Server } from 'node:http';

import { QA_WEB_FIXTURE_FACTS } from './cases.js';

export interface QaWebFixture {
  baseUrl: string;
  close: () => Promise<void>;
}

const HOME_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${QA_WEB_FIXTURE_FACTS.title}</title>
  </head>
  <body>
    <main>
      <h1>${QA_WEB_FIXTURE_FACTS.heading}</h1>
      <p role="status">${QA_WEB_FIXTURE_FACTS.status}</p>
      <a href="${QA_WEB_FIXTURE_FACTS.pricingPath}">${QA_WEB_FIXTURE_FACTS.pricingLinkText}</a>
    </main>
  </body>
</html>`;

const PRICING_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${QA_WEB_FIXTURE_FACTS.title} — Pricing</title>
  </head>
  <body>
    <main>
      <h1>${QA_WEB_FIXTURE_FACTS.pricingHeading}</h1>
      <a href="/">Back to smoke test</a>
    </main>
  </body>
</html>`;

function sendHtml(response: import('node:http').ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

export async function startQaWebFixture(): Promise<QaWebFixture> {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (request.method !== 'GET') {
      sendHtml(response, 405, '<h1>Method Not Allowed</h1>');
      return;
    }
    if (pathname === '/' || pathname === '/.' || pathname === '/index.html') {
      sendHtml(response, 200, HOME_PAGE);
      return;
    }
    if (pathname === QA_WEB_FIXTURE_FACTS.pricingPath) {
      sendHtml(response, 200, PRICING_PAGE);
      return;
    }
    sendHtml(response, 404, '<h1>Not Found</h1>');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('QA Web fixture did not expose a TCP address.');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
