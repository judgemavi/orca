import { z } from 'zod';
import { optionalNonEmptyTrimmedString, optionalStringField } from './common';

export const exploreSchema = z.object({
  query: optionalStringField,
  tool: optionalNonEmptyTrimmedString,
  model: optionalNonEmptyTrimmedString,
});

export const exploreContextSchema = z.object({
  content: optionalStringField,
});
