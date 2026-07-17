export const MAIN_AGENT_ID = 'main-agent';
export const QA_WEB_AGENT_ID = 'qa-web-agent';
export const PM_AGENT_ID = 'pm-agent';
export const RESERVED_AGENT_IDS = new Set<string>([
  MAIN_AGENT_ID,
  QA_WEB_AGENT_ID,
  PM_AGENT_ID,
]);

export type AgentSource = 'code' | 'stored';

export interface ChekkuAgentSummary {
  id: string;
  name: string;
  description?: string;
  source: AgentSource;
  model?: { provider: string; name: string };
  status?: 'draft' | 'published' | 'archived';
  createdAt?: string;
  updatedAt?: string;
}

export interface ChekkuAgentDetail extends ChekkuAgentSummary {
  instructions: string;
  memoryEnabled: boolean;
  tools: string[];
  agents: string[];
  mcpClients: string[];
}

export type ToolEventStatus =
  | 'running'
  | 'complete'
  | 'approval'
  | 'declined'
  | 'error';

export type ToolEvent = {
  id: string;
  messageId: string;
  toolCallId: string;
  toolName: string;
  status: ToolEventStatus;
  args?: unknown;
  result?: unknown;
  runId?: string;
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  error?: boolean;
  createdAt: number;
};
