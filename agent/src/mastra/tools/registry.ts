import { calculatorTool } from './calculator.js';
import { getCurrentTimeTool } from './get-current-time.js';

/**
 * Instance-level registry used by @mastra/editor when hydrating stored agents.
 */
export const storedAgentTools = {
  calculatorTool,
  getCurrentTimeTool,
};
