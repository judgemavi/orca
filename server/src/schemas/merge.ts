import { z } from 'zod';

export const mergeBodySchema = z.object({
  mode: z.string().optional(),
});
