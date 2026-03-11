import { z } from 'zod';
import { taskInsertDbSchema, taskUpdateDbSchema } from '../db/schema';
import {
  booleanRecordSchema,
  nonEmptyTrimmedString,
  optionalNonEmptyTrimmedString,
  optionalStringField,
} from './common';

const dependsOnSchema = z.array(nonEmptyTrimmedString).optional();
const autoRunOverridesSchema = booleanRecordSchema.optional();
const taskCreateDbFields = taskInsertDbSchema.pick({
  id: true,
  title: true,
  description: true,
  parentId: true,
  autoRunOverrides: true,
  workflow: true,
});
const taskUpdateDbFields = taskUpdateDbSchema.pick({
  title: true,
  description: true,
  status: true,
  autoRunOverrides: true,
});

export const createTaskSchema = taskCreateDbFields.extend({
  title: nonEmptyTrimmedString,
  description: optionalStringField,
  parentId: nonEmptyTrimmedString.nullable().optional(),
  dependsOn: dependsOnSchema,
  autoRunOverrides: autoRunOverridesSchema,
  workflow: optionalNonEmptyTrimmedString,
  id: optionalNonEmptyTrimmedString,
});

export const updateTaskSchema = taskUpdateDbFields.extend({
  title: optionalNonEmptyTrimmedString,
  description: optionalStringField,
  status: optionalNonEmptyTrimmedString,
  dependsOn: dependsOnSchema,
  autoRunOverrides: autoRunOverridesSchema,
});

export const provideInputSchema = z.object({
  answer: z.string().trim().min(1, 'answer is required'),
});

export const runRequestSchema = z.object({
  taskIds: dependsOnSchema,
  tool: optionalNonEmptyTrimmedString,
  model: optionalNonEmptyTrimmedString,
  context: optionalStringField,
});

export const resumeSchema = z.object({
  sessionId: optionalNonEmptyTrimmedString,
  feedback: optionalStringField,
  tool: optionalNonEmptyTrimmedString,
  model: optionalNonEmptyTrimmedString,
  context: optionalStringField,
});
