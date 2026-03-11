import { z } from 'zod';
import { memoryEntryUpdateDbSchema } from '../db/schema';
import { optionalNonEmptyTrimmedString } from './common';

export const memoryUpdateSchema = memoryEntryUpdateDbSchema.pick({
  content: true,
  confidence: true,
  category: true,
});

export const memoryRefreshSchema = z.object({
  entryId: optionalNonEmptyTrimmedString,
});
