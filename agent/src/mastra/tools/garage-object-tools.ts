import {
  createLazyGarageObjectStorage,
  createNamespacedObjectStorage,
  validateRelativeObjectKey,
  validateRelativeObjectPrefix,
  type ObjectStorage,
} from '@chekku/storage';
import { createTool, type ToolExecutionContext } from '@mastra/core/tools';
import { z } from 'zod';

const MAX_TEXT_BYTES = 262_144;
const TEXT_CONTENT_TYPE = 'text/plain; charset=utf-8';

const keySchema = z.string().superRefine((key, context) => {
  try {
    validateRelativeObjectKey(key);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid object key.' });
  }
});

const prefixSchema = z.string().superRefine((prefix, context) => {
  try {
    validateRelativeObjectPrefix(prefix);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid object prefix.' });
  }
});

const textSchema = z.string().refine(
  (text) => Buffer.byteLength(text, 'utf8') <= MAX_TEXT_BYTES,
  'Text must be at most 262,144 UTF-8 bytes.',
);

const keyInputSchema = z.object({ key: keySchema }).strict();
const writeInputSchema = z.object({ key: keySchema, text: textSchema }).strict();
const writeOutputSchema = z.object({ key: z.string(), sizeBytes: z.number().int().nonnegative() }).strict();

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const createAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const destructiveAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function storageForAgent(root: ObjectStorage, context: ToolExecutionContext): ObjectStorage {
  const agentId = context.agent?.agentId;
  if (!agentId) throw new Error('Agent identity is required.');
  return createNamespacedObjectStorage(root, agentId);
}

export function createCreateTextObjectTool(root: ObjectStorage = createLazyGarageObjectStorage()) {
  return createTool({
    id: 'create_text_object',
    description: 'Create a new UTF-8 text object in the current agent storage namespace.',
    inputSchema: writeInputSchema,
    outputSchema: writeOutputSchema,
    mcp: { annotations: createAnnotations },
    execute: async ({ key, text }, context) => {
      const storage = storageForAgent(root, context);
      await storage.createText(key, text, TEXT_CONTENT_TYPE);
      return { key, sizeBytes: Buffer.byteLength(text, 'utf8') };
    },
  });
}

export function createGetTextObjectTool(root: ObjectStorage = createLazyGarageObjectStorage()) {
  return createTool({
    id: 'get_text_object',
    description: 'Read a UTF-8 text object from the current agent storage namespace.',
    inputSchema: keyInputSchema,
    outputSchema: z.object({
      key: z.string(),
      text: z.string(),
      sizeBytes: z.number().int().nonnegative(),
    }).strict(),
    mcp: { annotations: readAnnotations },
    execute: async ({ key }, context) => {
      const text = await storageForAgent(root, context).getText(key);
      return { key, text, sizeBytes: Buffer.byteLength(text, 'utf8') };
    },
  });
}

export function createListTextObjectsTool(root: ObjectStorage = createLazyGarageObjectStorage()) {
  return createTool({
    id: 'list_text_objects',
    description: 'List UTF-8 text object keys in the current agent storage namespace.',
    inputSchema: z.object({ prefix: prefixSchema.optional() }).strict(),
    outputSchema: z.object({
      keys: z.array(z.string()).max(100),
      truncated: z.boolean(),
    }).strict(),
    mcp: { annotations: readAnnotations },
    execute: async ({ prefix = '' }, context) => {
      const result = await storageForAgent(root, context).listKeys(prefix, { limit: 101 });
      return {
        keys: result.keys.slice(0, 100),
        truncated: result.truncated || result.keys.length > 100,
      };
    },
  });
}

export function createReplaceTextObjectTool(root: ObjectStorage = createLazyGarageObjectStorage()) {
  return createTool({
    id: 'replace_text_object',
    description: 'Replace an existing UTF-8 text object in the current agent storage namespace.',
    inputSchema: writeInputSchema,
    outputSchema: writeOutputSchema,
    mcp: { annotations: destructiveAnnotations },
    execute: async ({ key, text }, context) => {
      const storage = storageForAgent(root, context);
      await storage.replaceText(key, text, TEXT_CONTENT_TYPE);
      return { key, sizeBytes: Buffer.byteLength(text, 'utf8') };
    },
  });
}

export function createDeleteObjectTool(root: ObjectStorage = createLazyGarageObjectStorage()) {
  return createTool({
    id: 'delete_object',
    description: 'Delete an existing object from the current agent storage namespace.',
    inputSchema: keyInputSchema,
    outputSchema: z.object({ key: z.string(), deleted: z.literal(true) }).strict(),
    mcp: { annotations: destructiveAnnotations },
    execute: async ({ key }, context) => {
      await storageForAgent(root, context).delete(key);
      return { key, deleted: true as const };
    },
  });
}
