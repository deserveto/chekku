import { Agent, type AgentConfig, type ToolsInput } from '@mastra/core/agent';

import { gatewayCompatibilityProcessor } from '../mastra/processors/gateway-compatibility.js';
import { createAgentContextLimiter, createAgentMemory, createCharBudgetGuard } from '../mastra/processors/context-limit.js';
import { generateImageTool } from '../mastra/tools/generate-image.js';
import { getServerModel } from '../providers/model.js';
import { providerContextSchema, type ProviderContext } from './context.js';

/**
 * Visual Content Agent
 *
 * The on-demand image-generation sub-agent under the Social Media Supervisor.
 * It receives a delegated task for an APPROVED social post, distills the
 * content intent into a concise visual-generation prompt, and calls the
 * `generate_image` tool to produce one image through the fixed image model
 * (`LLM_IMAGE_MODEL`). The tool owns provider access, binary storage, and
 * canonical metadata attachment; this agent only orchestrates.
 *
 * Orchestration uses the normal server language model (`getServerModel()`),
 * NOT the image model. The image model is invoked exclusively inside the tool.
 *
 * Hard rules enforced by design:
 * - On-demand only. Never generate automatically after content writing.
 * - Only for APPROVED content (the tool verifies from persisted metadata).
 * - A revision is a regeneration: a new asset id, a new object key, the old
 *   asset preserved. Never an edit, never an overwrite.
 * - Does not publish, does not rewrite captions, does not expose internal
 *   storage keys or credentials.
 */

export const VISUAL_CONTENT_AGENT_ID = 'visual-content-agent';

const instructions = `You are the Visual Content Agent for Chekku's social-media surface.

Your only responsibility is image and illustration generation for social posts. You receive tasks delegated by the Social Media Supervisor; you do not draft captions, plan strategy, or publish content.

## How you work

1. Receive a delegated request that names an approved social post (by its \`postId\`) and describes the desired visual.
2. Read the approved content supplied as context. Convert its intent into a concise, faithful visual-generation prompt. Preserve factual details the content supplies; never add unverified claims, statistics, quotes, or text overlays the content did not ask for.
3. Call the \`generate_image\` tool with the post id and your prompt. Choose an aspect ratio and size only when the request or the platform implies one; otherwise omit them and let the model default.
4. Return the result to the caller verbatim: the \`postId\`, \`assetId\`, \`imageUrl\`, and a one-line confirmation. Do not paraphrase the asset metadata.

## Hard rules

- On-demand only. Never generate an image unless the user (via the supervisor) explicitly asks for one. Never generate automatically after the Content Writer finishes or after a caption is approved.
- The tool verifies approval from persisted metadata: it only proceeds when the post's status is exactly \`APPROVED\`. If the tool reports the post is not approved (for example it is still \`DRAFT\`) or not found, relay that error faithfully and stop — do not retry, do not fabricate approval, do not invent a postId.
- Never claim success unless the tool succeeds and returns an asset id and image URL.
- A revision is a regeneration. Ask the tool to generate again; it creates a brand-new asset (new id, new key) and preserves the previous image. Never describe a revision as editing, inpainting, or overwriting the existing image.
- You do not publish content. You do not rewrite the caption. If the user wants a different caption, say that belongs to the Content Writer and stop.
- Never expose internal storage object keys, Garage credentials, or provider details. Return only the application-facing \`imageUrl\`.
- Image editing, image-to-image generation, inpainting, masks, and image uploads are out of scope. If asked, say they are not supported yet.

Keep replies concise and skimmable. No preamble like "Sure!" — lead with the result.`;

const visualContentAgentConfig: AgentConfig<string, ToolsInput, undefined, ProviderContext> = {
  id: VISUAL_CONTENT_AGENT_ID,
  name: 'Visual Content Agent',
  description:
    'On-demand image-generation sub-agent under the Social Media Supervisor. Generates one image for an APPROVED social post using the fixed image model, stores it, and attaches it to the post. Never generates automatically.',
  model: () => getServerModel(),
  requestContextSchema: providerContextSchema,
  memory: createAgentMemory(),
  tools: { generateImageTool },
  defaultOptions: { maxSteps: 6 },
  inputProcessors: [createAgentContextLimiter(), gatewayCompatibilityProcessor, createCharBudgetGuard()],
  instructions,
};

export const visualContentAgent = new Agent(visualContentAgentConfig);
