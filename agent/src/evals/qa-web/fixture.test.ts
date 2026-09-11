import { afterEach, describe, expect, it } from 'vitest';

import { QA_WEB_FIXTURE_FACTS } from './cases.js';
import { startQaWebFixture, type QaWebFixture } from './fixture.js';

let fixture: QaWebFixture | undefined;

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

describe('startQaWebFixture', () => {
  it('serves the stable home and pricing pages without external services', async () => {
    fixture = await startQaWebFixture();

    const home = await fetch(`${fixture.baseUrl}/`);
    const homeHtml = await home.text();
    expect(home.status).toBe(200);
    expect(homeHtml).toContain(`<title>${QA_WEB_FIXTURE_FACTS.title}</title>`);
    expect(homeHtml).toContain(`<h1>${QA_WEB_FIXTURE_FACTS.heading}</h1>`);
    expect(homeHtml).toContain(QA_WEB_FIXTURE_FACTS.pricingLinkText);

    const pricing = await fetch(`${fixture.baseUrl}${QA_WEB_FIXTURE_FACTS.pricingPath}`);
    const pricingHtml = await pricing.text();
    expect(pricing.status).toBe(200);
    expect(pricingHtml).toContain(`<h1>${QA_WEB_FIXTURE_FACTS.pricingHeading}</h1>`);
  });

  it('serves the prompt home path with a dot segment', async () => {
    fixture = await startQaWebFixture();

    const response = await fetch(`${fixture.baseUrl}/.`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain(`<h1>${QA_WEB_FIXTURE_FACTS.heading}</h1>`);
  });

  it('returns 404 for paths outside the fixture contract', async () => {
    fixture = await startQaWebFixture();
    const response = await fetch(`${fixture.baseUrl}/outside-scope`);
    expect(response.status).toBe(404);
  });
});
