export const MAIN_AGENT_ID = 'main-agent';
export const QA_WEB_AGENT_ID = 'qa-web-agent';
export const QA_ANDROID_AGENT_ID = 'qa-android-agent';
export const PM_AGENT_ID = 'pm-agent';
export const RESERVED_AGENT_IDS = new Set<string>([
  MAIN_AGENT_ID,
  QA_WEB_AGENT_ID,
  QA_ANDROID_AGENT_ID,
  PM_AGENT_ID,
  'social-media-supervisor-agent',
  'social-media-content-writer',
  'social-media-strategist-agent',
  'visual-content-agent',
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
  iconKey?: import('./agent-icons').AgentIconId;
}

export interface ChekkuAgentDetail extends ChekkuAgentSummary {
  instructions: string;
  memoryEnabled: boolean;
  tools: string[];
  agents: string[];
  mcpClients: string[];
  metadata?: Record<string, unknown>;
}

export type ToolEventStatus =
  | 'running'
  | 'complete'
  | 'approval'
  | 'declined'
  | 'error';

export type TextAssistantPart = {
  type: 'text';
  id: string;
  content: string;
};

export type ToolAssistantPart = {
  type: 'tool';
  id: string;
  toolCallId: string;
  toolName: string;
  status: ToolEventStatus;
  args?: unknown;
  result?: unknown;
  runId?: string;
};

/**
 * Ordered building block of one assistant turn. Streaming text deltas and
 * tool events are appended in arrival order so the timeline can render each
 * tool call at the exact point where it happened relative to the text.
 */
export type AssistantPart = TextAssistantPart | ToolAssistantPart;

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  /**
   * Full concatenated text of the turn. Kept in sync with text parts during
   * streaming so copy actions, empty checks, and Memory-restored messages
   * (which have no parts) keep working.
   */
  content: string;
  /** Present for assistant messages rendered from a live stream or restored parts. */
  parts?: AssistantPart[];
  error?: boolean;
  createdAt: number;
};
