import { type ToolsInput } from '@mastra/core/agent';
import {
  DurableAgent,
  type CreateDurableAgentOptions,
} from '@mastra/core/agent/durable';

/**
 * DurableAgent subclass that forwards the wrapped agent's description.
 *
 * The pinned `@mastra/core` 1.50.1 `DurableAgent` constructor forwards id,
 * name, instructions, and model to the base `Agent` but neither forwards nor
 * overrides `description`, so the wrapper's `getDescription()` returns an
 * empty string and the native `/api/agents` catalog renders the
 * "No description has been provided" fallback for durable-registered agents.
 *
 * A subclass — not post-construction mutation — is required because
 * `DurableAgent.__fork()` rebuilds the per-request clone with
 * `this.constructor`, so the override survives stored-agent editor and
 * version-preview forks.
 */
class DescriptionForwardingDurableAgent<
  TAgentId extends string = string,
  TTools extends ToolsInput = ToolsInput,
  TOutput = undefined,
> extends DurableAgent<TAgentId, TTools, TOutput> {
  override getDescription(): string {
    return this.agent.getDescription();
  }
}

/**
 * Create a description-forwarding durable agent.
 *
 * Drop-in replacement for the pinned `createDurableAgent` factory with the
 * same options and the same upstream `DurableAgent` return contract; the only
 * behavioral difference is that `getDescription()` exposes the wrapped
 * agent's configured description instead of an empty string.
 */
export function createDescriptionForwardingDurableAgent<
  TAgentId extends string = string,
  TTools extends ToolsInput = ToolsInput,
  TOutput = undefined,
>(
  options: CreateDurableAgentOptions<TAgentId, TTools, TOutput>,
): DurableAgent<TAgentId, TTools, TOutput> {
  return new DescriptionForwardingDurableAgent<TAgentId, TTools, TOutput>(
    options,
  );
}
