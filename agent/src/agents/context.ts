import { z } from 'zod';
import type { RequestContext } from '@mastra/core/request-context';

export const providerContextSchema = z.object({
  browserAccess: z.enum(['approval', 'full']).optional(),
});

export type ProviderContext = z.infer<typeof providerContextSchema>;
