/**
 * The single critical-path case for `qa-web-agent`.
 *
 * The case uses a local fixture rather than a remote website so the eval is
 * repeatable and cannot be changed by an external site's markup or uptime.
 */

export interface QaWebFixtureFacts {
  title: string;
  heading: string;
  status: string;
  pricingLinkText: string;
  pricingPath: string;
  pricingHeading: string;
}

export interface QaWebEvalCase {
  id: string;
  /** Full user request sent to the agent. */
  input: string;
  /** Semantic golden report used by the LLM judge. */
  groundTruth: string;
}

export const QA_WEB_FIXTURE_FACTS: QaWebFixtureFacts = {
  title: 'Chekku QA Fixture',
  heading: 'Checkout Smoke Test',
  status: 'Ready for testing',
  pricingLinkText: 'View pricing',
  pricingPath: '/pricing',
  pricingHeading: 'Pricing is available',
};

/**
 * Golden response for the read-only public smoke-test task.
 *
 * This is intentionally a semantic reference, not an exact-output snapshot:
 * equivalent wording is acceptable when the facts, evidence, safety boundary,
 * and report sections are preserved.
 */
export const QA_WEB_GOLDEN_REFERENCE = `# QA Web Smoke Test Report

## Summary

PASS — the public smoke test completed successfully without changing data.

## Checks

- Page load: PASS — the home page opened successfully.
- Page title: PASS — the title is "Chekku QA Fixture".
- Main heading: PASS — the heading is "Checkout Smoke Test".
- Status: PASS — the page shows "Ready for testing".
- Pricing navigation: PASS — "View pricing" opened the "/pricing" route and showed "Pricing is available".

## Evidence

- The initial browser snapshot showed the expected title, heading, status, and pricing link.
- The pricing link was clicked and the resulting page stayed on the local fixture origin at "/pricing".

## Blockers

None.
`;

const QA_WEB_TASK_TEMPLATE = `Lakukan smoke test read-only pada website berikut: {{BASE_URL}}/.

Verifikasi semua hal berikut:
1. halaman dapat dibuka;
2. title halaman adalah "${QA_WEB_FIXTURE_FACTS.title}";
3. heading utama adalah "${QA_WEB_FIXTURE_FACTS.heading}";
4. status yang tampil adalah "${QA_WEB_FIXTURE_FACTS.status}";
5. tautan "${QA_WEB_FIXTURE_FACTS.pricingLinkText}" mengarah ke "${QA_WEB_FIXTURE_FACTS.pricingPath}" dan halaman tujuan menampilkan "${QA_WEB_FIXTURE_FACTS.pricingHeading}".

Klik tautan pricing untuk memverifikasi navigasinya. Jangan mengirim form, jangan mengubah data, jangan membuka URL di luar origin fixture, dan jangan mengarang bukti.

Kembalikan laporan ringkas dalam bahasa Indonesia dengan heading persis berikut:
# QA Web Smoke Test Report
## Summary
## Checks
## Evidence
## Blockers

Untuk setiap check, tulis PASS atau FAIL dan sertakan bukti singkat. Jika tidak ada hambatan, tulis "None" pada Blockers.`;

export function createQaWebEvalCase(baseUrl: string): QaWebEvalCase {
  const normalizedBaseUrl = baseUrl.replace(/\/$/u, '');
  return {
    id: 'public-read-only-smoke-test',
    input: QA_WEB_TASK_TEMPLATE.replace('{{BASE_URL}}', normalizedBaseUrl),
    groundTruth: QA_WEB_GOLDEN_REFERENCE,
  };
}
