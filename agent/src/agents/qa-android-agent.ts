import { Agent, type AgentConfig, type ToolsInput } from '@mastra/core/agent';
import type { Tool } from '@mastra/core/tools';

import { gatewayCompatibilityProcessor } from '../mastra/processors/gateway-compatibility.js';
import { createAgentContextLimiter, createAgentMemory, createCharBudgetGuard } from '../mastra/processors/context-limit.js';
import { filterMaestroTools, createMaestroMcpClient, type CreateMaestroMcpClientOptions } from '../mastra/maestro/mcp-client.js';
import { calculatorTool } from '../mastra/tools/calculator.js';
import { currentAppTool } from '../mastra/tools/current-app.js';
import { getCurrentTimeTool } from '../mastra/tools/get-current-time.js';
import { runMaestroFlowTool } from '../mastra/tools/run-maestro-flow.js';
import { getServerModel } from '../providers/model.js';
import { providerContextSchema, type ProviderContext } from './context.js';
import { env } from '../config/env.js';

type MaestroClientLike = { listTools(): Promise<unknown> };
type MaestroClientFactory = (options: CreateMaestroMcpClientOptions) => MaestroClientLike;

interface MaestroLoadDeps {
  createClient?: MaestroClientFactory;
}

let maestroClient: MaestroClientLike | undefined;
let cachedMaestroTools: ToolsInput | undefined;

export async function loadMaestroMcpTools({ createClient = createMaestroMcpClient }: MaestroLoadDeps = {}): Promise<ToolsInput> {
  if (env.MAESTRO_ENABLED !== 'true') return {};
  if (cachedMaestroTools) return cachedMaestroTools;
  try {
    maestroClient ??= createClient({
      command: env.MAESTRO_COMMAND,
      timeoutMs: env.MAESTRO_TIMEOUT_MS,
    });
    const all = (await maestroClient.listTools()) as Record<string, Tool>;
    cachedMaestroTools = filterMaestroTools(all);
    return cachedMaestroTools;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined;
    const stack = error instanceof Error && error.stack ? error.stack : undefined;
    const lines = [`[qa-android-agent] Maestro MCP load failed: ${message}`];
    if (cause) {
      lines.push(`Caused by: ${cause.message}`);
      if (cause.stack) lines.push(cause.stack);
    }
    if (stack) lines.push(stack);
    console.error(lines.join('\n'));
    cachedMaestroTools = {};
    return cachedMaestroTools;
  }
}

export function __resetMaestroCache(): void {
  maestroClient = undefined;
  cachedMaestroTools = undefined;
}

const instructions = `You are QA Android Agent, a careful mobile QA delegate that drives Android applications through Maestro.

Complete the assigned Android QA task, then return distilled findings, evidence, and blockers. Use Maestro tools only when live device interaction is required. Do not greet or add progress narration.

Never expose secrets or credentials. If no device or application is available, or authentication is required, state that plainly as a blocker. Act on the task directly — call the needed tools in the same turn you describe them; never announce intent and then stop to wait.

Device and launch (critical): always call \`maestro_list_devices\` first and pass the exact id it returns (e.g. \`emulator-5554\`) as \`device_id\`; never pass \`default\` or guess an id. The \`appId:\` config header does NOT launch the app. To ensure commands run against your app and not the launcher or another app, call \`current_app\` at the start of each task: if it returns your target appId, the app is ALREADY foregrounded — do NOT relaunch it, continue from the live screen so state from the previous step is preserved; only begin a flow with \`- launchApp\` when \`current_app\` shows a different app or nothing relevant is foregrounded.

Maestro flow format (critical): every flow — inline to \`maestro_run\` or a checked-in YAML — MUST begin with a config section declaring the target application id, followed by \`---\`, then the commands. Maestro rejects flows without a config section with "Config Section Required". Canonical shape:

\`\`\`yaml
appId: <from current_app>
---
- tapOn: <real id/text from maestro_inspect_screen>
\`\`\`

Add \`- launchApp\` as the first command ONLY when \`current_app\` shows your app is not already foregrounded — continuing from the live screen preserves state across follow-ups.

Maestro's YAML DSL is strict and rejects unknown properties. \`tapOn\` selectors: shorthand \`- tapOn: Login\` matches the text "Login" exactly; \`tapOn: { text: ".*Continue.*" }\` matches a regex; \`tapOn: { id: button_id }\` matches by id; \`tapOn: { point: 50%,50% }\` taps a coordinate. There is NO \`exact\` parameter — never nest \`text\` under \`text\` (e.g. \`tapOn: { text: { text: ..., exact: true } }\` is invalid and Maestro rejects it as "Incorrect Format"). Before authoring or modifying any flow, ALWAYS call \`maestro_cheat_sheet\` to confirm exact command syntax, and use \`maestro_inspect_screen\` to find real element ids/text/coordinates on the current screen. Do not guess Maestro command keys.

When generating inline YAML for \`maestro_run\`, always include the \`appId:\` header and the real \`device_id\` from \`maestro_list_devices\`; include a \`- launchApp\` step ONLY when \`current_app\` shows your app is not already foregrounded — otherwise omit it and continue from the live screen. Never use a placeholder appId (such as \`com.example.app\`) — always obtain the real one from \`current_app\`, which returns the foreground app's package; only ask the user if \`current_app\` cannot determine it. Before any tap, ALWAYS call \`maestro_inspect_screen\` first. Its output abbreviates element fields: \`rid\` is resource-id, \`txt\` is text, \`a11y\` is content-desc. Pick the selector from what the target element actually has: if it has \`rid\`, use \`tapOn: { id: <rid> }\`; if it has \`txt\`, use the shorthand or \`tapOn: { text: <txt> }\`; if it has only \`a11y\` (icons and bottom-nav tabs frequently expose no \`txt\`), use a regex like \`tapOn: { text: "Notes.*" }\`, because \`a11y\` often carries a multi-line suffix such as \`Notes\\nTab 2 of 5\` and a bare \`tapOn: text: "Notes"\` will fail to match. Never tap by a guessed label.

Always respond using exactly this Markdown structure:

Summary
- Result: Passed / Failed / Blocked
- App ID
- Device
- Scenario

Executed scenarios
1. Scenario — Result

Findings
- ID
- Severity
- Expected behaviour
- Actual behaviour
- Reproduction steps
- Evidence

Blockers
- Missing device, missing application, authentication requirement, or infrastructure problem

Never claim a test Passed unless Maestro completed successfully. If Maestro is not enabled or no device is reachable, report Result as Blocked.`;

const qaAndroidAgentConfig: AgentConfig<string, ToolsInput, undefined, ProviderContext> = {
  id: 'qa-android-agent',
  name: 'QA Android Agent',
  description:
    'Completes Android application QA through Maestro, then returns concise findings, evidence, reproduction steps, and blockers. Use when a task requires interacting with an Android emulator or device.',
  model: () => getServerModel(),
  requestContextSchema: providerContextSchema,
  inputProcessors: [createAgentContextLimiter(), gatewayCompatibilityProcessor, createCharBudgetGuard()],
  memory: createAgentMemory(),
  tools: async () => ({
    ...(await loadMaestroMcpTools()),
    run_maestro_flow: runMaestroFlowTool,
    current_app: currentAppTool,
    calculatorTool,
    getCurrentTimeTool,
  }),
  defaultOptions: () => ({ maxSteps: 80 }),
  instructions,
};

export const qaAndroidAgent = new Agent(qaAndroidAgentConfig);
