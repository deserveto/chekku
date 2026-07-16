import { z } from 'zod';
import type { RequestContext } from '@mastra/core/request-context';

export const providerContextSchema = z.object({});

export type ProviderContext = z.infer<typeof providerContextSchema>;
