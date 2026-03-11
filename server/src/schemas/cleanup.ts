import { z } from 'zod';

export const cleanupSchema = z.object({
  dryRun: z.boolean().optional(),
});
