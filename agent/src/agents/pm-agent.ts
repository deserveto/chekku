import { Agent, type AgentConfig, type ToolsInput } from '@mastra/core/agent';
import { createDurableAgent } from '@mastra/core/agent/durable';

import { createCompetitiveResearchGuard } from '../mastra/processors/competitive-research-guard.js';
import { createAgentContextLimiter, createAgentMemory, createCharBudgetGuard } from '../mastra/processors/context-limit.js';
import { getServerModel } from '../providers/model.js';
import {
  listCompetitiveAnalysesFromGarageTool,
  saveCompetitiveAnalysisToGarageTool,
  viewCompetitiveAnalysisFromGarageTool,
} from '../mastra/tools/competitive-analysis-tools.js';
import { searchWebTool } from '../mastra/tools/searxng-search.js';
import { readWebPageTool } from '../mastra/tools/web-reader.js';
import { withCompetitiveResearchBudget } from '../mastra/tools/competitive-research-budget.js';
import {
  listPmReportsFromGarageTool,
  savePmReportToGarageTool,
  viewPmReportFromGarageTool,
} from '../mastra/tools/pm-report-tools.js';
import { providerContextSchema, type ProviderContext } from './context.js';
import { competitiveAnalysisSkill, weeklyReportAnalysisSkill } from './pm-agent-skills.js';

const instructions = `You are PM Agent, a senior project manager for weekly delivery risk and product competitive analysis.

Route intent before acting:

- For /weekly-report-analysis, an engineering weekly report, or an explicit weekly analysis request, load weekly-report-analysis and follow it completely.
- For /competitive-analysis or an equivalent natural-language competitive analysis request, load competitive-analysis and follow it completely.
- For explicit requests to list saved competitive analyses, call list_competitive_analyses_from_garage and return analysesMarkdown unchanged. Do not reconstruct, summarize, reorder, or convert the rows into prose. Its rows use report links in the required [<analysisId>](<analysisUrl>) form.
- For explicit requests to view a competitive analysis, call view_competitive_analysis_from_garage. A canonical pca_ id always selects competitive view behavior. Return saved analysisMarkdown first, then a short metadata block.
- Generic requests to list saved reports mean weekly reports for compatibility. Call list_pm_reports_from_garage and return reportsMarkdown unchanged. Do not reconstruct, summarize, reorder, or convert the rows into prose. Its rows use report links in the required [<reportId>](<reportUrl>) form.
- For requests to view a weekly report, call view_pm_report_from_garage. A canonical pmr_ id always selects weekly view behavior. Return saved analysisMarkdown first, then a short metadata block with reportId, createdAt, rating, and status.
- If a view request has no id, ask for the id or offer the matching list.
- Answer unrelated messages conversationally as PM Agent. Do not load an analysis skill or use report tools.`;

const pmAgentConfig: AgentConfig<string, ToolsInput, undefined, ProviderContext> = {
  id: 'pm-agent',
  name: 'PM Agent',
  description: 'Analyzes engineering weekly reports and product competition, then saves completed analyses to Garage.',
  model: () => getServerModel(),
  requestContextSchema: providerContextSchema,
  tools: {
    save_competitive_analysis_to_garage: withCompetitiveResearchBudget('save_competitive_analysis_to_garage', saveCompetitiveAnalysisToGarageTool),
    list_competitive_analyses_from_garage: listCompetitiveAnalysesFromGarageTool,
    view_competitive_analysis_from_garage: viewCompetitiveAnalysisFromGarageTool,
    save_pm_report_to_garage: savePmReportToGarageTool,
    list_pm_reports_from_garage: listPmReportsFromGarageTool,
    view_pm_report_from_garage: viewPmReportFromGarageTool,
    search_web: withCompetitiveResearchBudget('search_web', searchWebTool),
    read_web_page: withCompetitiveResearchBudget('read_web_page', readWebPageTool),
  },
  skills: [weeklyReportAnalysisSkill, competitiveAnalysisSkill],
  memory: createAgentMemory(),
  inputProcessors: [
    createCompetitiveResearchGuard(),
    createAgentContextLimiter(),
    createCharBudgetGuard(),
  ],
  defaultOptions: { maxSteps: 25 },
  instructions,
};

export const pmAgent = new Agent(pmAgentConfig);

/**
 * Durable execution pilot (N8_4): the PM Agent runs the longest jobs on the
 * server (competitive research: up to 25 steps, bounded web research, one
 * save), so it is the pilot agent wrapped with `createDurableAgent`.
 *
 * The wrapper runs the same agentic loop inside the built-in workflow
 * engine using the default in-process PubSub and in-memory event cache —
 * no Redis, no external infra. Public identity is unchanged (id stays
 * `pm-agent`, the composition key stays `pmAgent`), so `getAgentById`,
 * thread-id ownership (`{agentId}-{resourceId}-{uuid}`), and the whole
 * `/runs` HTTP surface work unchanged against the wrapped instance.
 *
 * Stop still flows through the run registry's AbortController
 * (`abortSignal` is forwarded to the durable run's internal controller).
 * Resume is conversational: after a stop, prompting again in the SAME
 * thread continues from persisted Memory context instead of restarting.
 * The run-execution driver calls the stream result's `cleanup()` once the
 * run reaches a terminal state so durable registry entries and PubSub
 * subscriptions never leak.
 *
 * Crash recovery is intentionally NOT enabled: `recoverActiveRuns` /
 * `recovery.durableAgents` do not exist in the pinned `@mastra/core`
 * 1.50.1, and re-driving abandoned runs would re-issue real LLM calls.
 */
export const durablePmAgent = createDurableAgent({
  // The factory's `agent` parameter leaves the request-context generic at
  // `unknown` while code-defined agents carry a zod `requestContextSchema`
  // (`ProviderContext`); the runtime shapes are identical but TypeScript
  // contravariance on the model callback rejects the direct assignment.
  // Re-run the agent typecheck whenever `@mastra/core` moves.
  agent: pmAgent as Agent<string, ToolsInput, undefined>,
});
