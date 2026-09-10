export interface PmEvalReference {
  referenceResponse: string;
  mustInclude: string[];
  mustNot: string[];
  evaluationMode: string;
  hardChecks: {
    requiredPhrases: string[];
    forbiddenPhrases: string[];
    requiredPatterns: string[];
    forbiddenTools: string[];
  };
}

export interface PmEvalCase {
  id: string;
  criticalPath: string;
  input: string;
  reference: PmEvalReference;
}

const FORBIDDEN_SAVE_RECEIPTS = ['Saved reportId:', 'Saved analysisId:'];
const FORBIDDEN_RESEARCH_AND_PERSISTENCE_TOOLS = [
  'search_web',
  'read_web_page',
  'save_pm_report_to_garage',
  'list_pm_reports_from_garage',
  'view_pm_report_from_garage',
  'save_competitive_analysis_to_garage',
  'list_competitive_analyses_from_garage',
  'view_competitive_analysis_from_garage',
];

/**
 * Small, response-focused PM suite. External research and persistence are
 * intentionally excluded from this first-level eval so it runs without
 * Garage or SearXNG.
 */
export const PM_EVAL_CASES: PmEvalCase[] = [
  {
    id: 'weekly-risk-analysis',
    criticalPath: 'Turn an engineering weekly report into an evidence-backed risk review.',
    input: `/weekly-report-analysis

For this evaluation, return the analysis Markdown only. The evaluation harness disables persistence tools; do not invent a save receipt.

Analyze this engineering weekly report:

- Checkout API integration: backend merged, but the payment provider sandbox intermittently returns 502. Owner: Payments. Production pilot is Friday.
- Android QA: 18 of 24 flows pass. Six fail on Android 14 because of a deep-link redirect. The fix has not started. Owners: QA and Mobile.
- Release documentation: the runbook is drafted and reviewed by the release team.`,
    reference: {
      evaluationMode: 'response-only; no persistence receipt is expected',
      referenceResponse: `**Risk Rating: 9/10 - IN-DANGER**
**Headline:** Payment instability and Android 14 deep-link failures put Friday's production pilot at risk.

## Summary
The dominant risk is release readiness ahead of Friday's production pilot. The report says the payment provider sandbox "intermittently returns 502" and that "Six fail on Android 14 because of a deep-link redirect"; together these leave the checkout path and a meaningful portion of mobile coverage unreliable. The Android fix "has not started", so the schedule has little recovery margin.

## Flagged Issues

### [CRITICAL] Payment provider instability - IN-DANGER
The payment provider sandbox "intermittently returns 502", which can block or make checkout unreliable during the production pilot. **Affected:** Payments, checkout integration, and Friday's production pilot.

### [HIGH] Android 14 deep-link failures - IN-DANGER
"Six fail on Android 14 because of a deep-link redirect" and the fix "has not started". This leaves 6 of 24 flows failing and creates a material mobile release risk. **Affected:** QA, Mobile, Android 14 coverage, and the pilot timeline.

## On Track
- Release documentation: the runbook is drafted and reviewed by the release team.

## Recommended Actions
1. Assign Payments an owner and deadline to reproduce, isolate, and resolve the intermittent 502 before the Friday pilot; define a go/no-go check for checkout.
2. Start the Android 14 deep-link investigation immediately, assign QA and Mobile owners, and rerun all 24 flows after the fix.
3. Hold a pre-pilot readiness review with explicit payment and Android 14 exit criteria.`,
      mustInclude: [
        'Use the weekly risk-review Markdown structure with risk rating, headline, summary, flagged issues, on-track items, and recommended actions.',
        'Quote the exact report phrases about intermittent 502s, Android 14 deep-link failures, and the fix not starting.',
        'Treat the payment issue as the dominant release risk and explain its concrete impact on Friday\'s pilot.',
        'Mention the reviewed release runbook as on track.',
        'Give concrete, prioritized actions for Payments and Mobile/QA.',
        'Use a rating/status combination consistent with an in-danger release risk.',
      ],
      mustNot: [
        'Invent a saved reportId or claim that a persistence tool succeeded.',
        'Introduce facts not present in the supplied report.',
        'Use JSON or wrap the whole answer in a code fence.',
      ],
      hardChecks: {
        requiredPhrases: [
          '## Summary',
          '## Flagged Issues',
          '## On Track',
          '## Recommended Actions',
          'intermittently returns 502',
          'Six fail on Android 14 because of a deep-link redirect',
          'has not started',
        ],
        forbiddenPhrases: FORBIDDEN_SAVE_RECEIPTS,
        requiredPatterns: [
          '\\*\\*Risk Rating:\\s*(?:8|9|10)\\/10\\s*[-\\u2014]\\s*IN-DANGER',
        ],
        forbiddenTools: FORBIDDEN_RESEARCH_AND_PERSISTENCE_TOOLS,
      },
    },
  },
  {
    id: 'competitive-missing-anchor',
    criticalPath: 'Gate competitive-analysis intake when no anchor product is named.',
    input: `/competitive-analysis

For this evaluation, do not call external research or persistence tools.

Please compare project-management platforms for our company. I have not chosen an anchor product or supplied a product URL. Start the research anyway and tell me which platform is best.`,
    reference: {
      evaluationMode: 'intake-only; no research or persistence receipt is expected',
      referenceResponse: `I need at least one named product before starting the competitive analysis. The first product you name will be the anchor; you may also provide a market/category, an official anchor URL, seed competitors, and comparison focus areas.

Please provide the anchor product and, if you have them, any mandatory competitors or URLs. I will not choose an anchor for you or make a recommendation from unsupported research.`,
      mustInclude: [
        'Ask the user to name at least one product before research.',
        'Explain that the first named product becomes the anchor.',
        'Offer relevant optional context such as market/category, URLs, seed competitors, or focus areas.',
        'Keep the response as an intake clarification rather than producing a comparison.',
      ],
      mustNot: [
        'Claim that search or page-reading tools were called.',
        'Select an anchor product on the user\'s behalf.',
        'Make product, feature, pricing, or recommendation claims without evidence.',
        'Claim that an analysis was saved.',
      ],
      hardChecks: {
        requiredPhrases: ['anchor', 'research'],
        forbiddenPhrases: FORBIDDEN_SAVE_RECEIPTS,
        requiredPatterns: [
          '(?:before|until|without|prior\\s+to).{0,80}(?:research|competitive[-\\s]analysis)|(?:can(?:not|\'t)?|will\\s+not|won\'t).{0,80}(?:research|competitive[-\\s]analysis)',
        ],
        forbiddenTools: FORBIDDEN_RESEARCH_AND_PERSISTENCE_TOOLS,
      },
    },
  },
  {
    id: 'competitive-too-many-competitors',
    criticalPath: 'Reject competitive-analysis intake with more than seven supplied competitors.',
    input: `/competitive-analysis

For this evaluation, do not call external research or persistence tools.

Compare Notion against Slack, Jira, Linear, Asana, Trello, Monday.com, ClickUp, and Basecamp for a distributed engineering team. These are the competitors I want included; proceed with research now.`,
    reference: {
      evaluationMode: 'intake-only; no research or persistence receipt is expected',
      referenceResponse: `Please narrow the competitor list before research. Notion is the anchor, and the request supplies eight competitors: Slack, Jira, Linear, Asana, Trello, Monday.com, ClickUp, and Basecamp. The competitive-analysis workflow supports five to seven competitors alongside the anchor, so please select at most seven to keep.

After you confirm the reduced set, I can research each required product using primary public evidence and compare them against Notion.`,
      mustInclude: [
        'Identify Notion as the anchor.',
        'Recognize that eight competitors were supplied.',
        'Ask the user to reduce the list to at most seven competitors before research.',
        'Do not draft a competitive matrix or conclusions yet.',
      ],
      mustNot: [
        'Silently drop a user-supplied competitor.',
        'Call or claim to call research tools before the list is narrowed.',
        'Make unsupported feature, pricing, positioning, or recommendation claims.',
        'Claim that an analysis was saved.',
      ],
      hardChecks: {
        requiredPhrases: ['Notion', 'competitor'],
        forbiddenPhrases: FORBIDDEN_SAVE_RECEIPTS,
        requiredPatterns: [
          '(?:eight|8)\\s+(?:supplied\\s+)?competitors',
          '(?:at\\s+most|no\\s+more\\s+than|maximum(?:\\s+of)?|max\\.?|five\\s+to).{0,40}(?:seven|7)|(?:5|five)\\s*[-\\u2013\\u2014]\\s*(?:7|seven)',
          '(?:before|prior to|until).{0,60}research',
        ],
        forbiddenTools: FORBIDDEN_RESEARCH_AND_PERSISTENCE_TOOLS,
      },
    },
  },
];
