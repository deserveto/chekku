import { describe, it, expect } from 'vitest';
import { mainAgent } from '../main-agent.js';
import { pmAgent } from '../pm-agent.js';
import { qaWebAgent } from '../qa-web-agent.js';
import { qaAndroidAgent } from '../qa-android-agent.js';
import { socialMediaAgent } from '../social-media-agent.js';

describe('main-agent (general Chekku Assistant)', () => {
  it('has id main-agent', () => {
    expect(mainAgent.id).toBe('main-agent');
  });

  it('has name Chekku Assistant', () => {
    expect(mainAgent.name).toBe('Chekku Assistant');
  });
});

describe('qa-web-agent (browser QA)', () => {
  it('has id qa-web-agent', () => {
    expect(qaWebAgent.id).toBe('qa-web-agent');
  });

  it('has name QA Web Agent', () => {
    expect(qaWebAgent.name).toBe('QA Web Agent');
  });

  it('has listBrowserTools method (browser integration present)', () => {
    expect(typeof (qaWebAgent as unknown as Record<string, unknown>).listBrowserTools).toBe('function');
  });

  it('binds calculator and get-current-time tools', async () => {
    const tools = await qaWebAgent.listTools();
    expect(Object.keys(tools).sort()).toEqual([
      'calculatorTool',
      'getCurrentTimeTool',
    ]);
  });
});

describe('pm-agent (weekly report analysis)', () => {
  it('has built-in identity, memory, and PM report plus search tools', async () => {
    expect(pmAgent.id).toBe('pm-agent');
    expect(pmAgent.name).toBe('PM Agent');
    expect(await pmAgent.getMemory()).toBeDefined();

    const tools = await pmAgent.listTools();
    expect(Object.keys(tools).sort()).toEqual([
      'list_pm_reports_from_garage',
      'read_web_page',
      'save_pm_report_to_garage',
      'search_web',
      'view_pm_report_from_garage',
    ]);
    expect(await pmAgent.getDefaultOptions()).toMatchObject({ maxSteps: 12 });
  });

  it('preserves the complete PM instruction contract', async () => {
    const instructions = await pmAgent.getInstructions();

    expect(instructions).toBe(`You are PM Agent, a senior project manager who analyzes engineering weekly reports and rates project risk.

Decide what to do based on the user's message.

## When the user asks to list saved reports

Call the list_pm_reports_from_garage tool and use its reportsMarkdown value; return it unchanged. Do not reconstruct, summarize, reorder, or convert the rows into prose. Its rows use report links in the required [<reportId>](<reportUrl>) form.

## When the user asks to view, read, open, or show a saved report

If the user provided a report id, call the view_pm_report_from_garage tool with that reportId. Return the saved analysisMarkdown first, then a short metadata block with reportId, createdAt, rating, and status. If no report id was provided, ask for the reportId or offer to list saved reports.

## When the message is an engineering weekly report or explicitly asks you to analyze one

Produce a risk review as Markdown using exactly this template:

**Risk Rating: <integer 1-10>/10 — <STATUS>**
**Headline:** <one sentence capturing the single most important thing>

## Summary
<1 to 2 paragraphs. Name the dominant risk theme and what is at stake. Back every claim by quoting exact words from the report.>

## Flagged Issues
For every concrete issue, use this sub-format:

### [<SEVERITY>] <issue title> — <STATUS>
<2 to 4 sentences. Quote the exact phrase from the report, state concrete impact, then justify severity.>
**Affected:** <teams / systems / timeline>

## On Track
<Short bullets of items that are genuinely fine. If none, write "- Nothing notable this week.">

## Recommended Actions
1. <highest-priority concrete next step tied to the top risk>
2. <second concrete next step, if useful>
3. <third concrete next step, if useful>

Hard rules:
- <STATUS> is derived from rating: 1-3 = ON-TRACK, 4-7 = WARNING, 8-10 = IN-DANGER.
- <SEVERITY> is one of CRITICAL, HIGH, MEDIUM, LOW.
- If any issue is CRITICAL, overall rating MUST be 9 or 10.
- Summary and every flagged issue must quote exact report text.
- Every flagged issue must state concrete impact.
- Output Markdown only. No JSON. No code fences around the whole reply.
- After writing the Markdown analysis, call save_pm_report_to_garage with original report as reportMarkdown and your analysis as analysisMarkdown. In final response, include the Markdown analysis and "Saved reportId: <reportId>".
- If save_pm_report_to_garage fails, still return the Markdown analysis and add one short line explaining Garage save failed.

## When the message is anything else

Answer in plain conversational prose. Do not use the risk report template. Introduce yourself as PM Agent and invite the user to paste a weekly report.`);
  });
});

describe('agent differentiation', () => {
  it('main-agent and qa-web-agent have different ids', () => {
    expect(mainAgent.id).not.toBe(qaWebAgent.id);
  });

  it('main-agent and qa-web-agent have different names', () => {
    expect(mainAgent.name).not.toBe(qaWebAgent.name);
  });
});

it('qa-web-agent has Mastra memory for browser context', async () => {
  const memory = await qaWebAgent.getMemory();

  expect(memory).toBeDefined();
});

describe('qa-android-agent (Maestro Android QA)', () => {
  it('has id qa-android-agent and name QA Android Agent', () => {
    expect(qaAndroidAgent.id).toBe('qa-android-agent');
    expect(qaAndroidAgent.name).toBe('QA Android Agent');
  });

  it('has Mastra memory', async () => {
    expect(await qaAndroidAgent.getMemory()).toBeDefined();
  });

  it('binds run_maestro_flow, calculator, and current-time tools', async () => {
    const tools = await qaAndroidAgent.listTools();
    expect(Object.keys(tools).sort()).toEqual(
      expect.arrayContaining(['calculatorTool', 'getCurrentTimeTool', 'run_maestro_flow']),
    );
  });
});

describe('agent differentiation (all five agents)', () => {
  it('has mutually distinct ids', () => {
    const ids = [mainAgent.id, pmAgent.id, qaWebAgent.id, qaAndroidAgent.id, socialMediaAgent.id];
    expect(new Set(ids).size).toBe(ids.length);
  });
});
