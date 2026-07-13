import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  standardSchemaToJSONSchema,
  toStandardSchema,
} from '@mastra/core/schema';
import { providerContextSchema } from '../agents/context.js';

const require = createRequire(import.meta.url);

describe('Mastra schema compatibility', () => {
  it('keeps the application on the Zod 3 compatibility line', () => {
    const zodPackage = require('zod/package.json') as { version: string };

    expect(zodPackage.version).toMatch(/^3\.25\./);
  });

  it('converts the optional request context schema to JSON Schema', () => {
    const standardSchema = toStandardSchema(providerContextSchema);
    const jsonSchema = standardSchemaToJSONSchema(standardSchema);

    expect(jsonSchema).toMatchObject({
      type: 'object',
      properties: {
        browserAccess: {
          type: 'string',
          enum: ['approval', 'full'],
        },
      },
    });
  });
});
