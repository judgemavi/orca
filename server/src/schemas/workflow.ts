import { z } from 'zod';
import { interactionUpdateDbSchema } from '../db/schema';
import {
  nonEmptyTrimmedString,
  optionalNonEmptyTrimmedString,
  optionalStringField,
  unknownRecordSchema,
} from './common';

export const toolModelSchema = z.object({
  tool: optionalNonEmptyTrimmedString,
  model: optionalNonEmptyTrimmedString,
});

export const requestChangesSchema = toolModelSchema.extend({
  feedback: optionalStringField,
  interactionId: optionalNonEmptyTrimmedString,
});

export const enqueueStepSchema = toolModelSchema.extend({
  prompt: optionalStringField,
});

const proposedTaskSchema = z.object({
  title: nonEmptyTrimmedString,
  description: optionalStringField.default(''),
  dependsOn: z.array(nonEmptyTrimmedString).optional(),
  dependsOnIndices: z.array(z.number()).optional().default([]),
  suggestedTool: z.string().optional().default(''),
});

export const breakdownAcceptSchema = z.object({
  interactionId: optionalNonEmptyTrimmedString,
  tasks: z.array(proposedTaskSchema).optional(),
});

export const breakdownRejectSchema = z.object({
  interactionId: optionalNonEmptyTrimmedString,
});

export const completeStepSchema = z.object({
  outcome: z.string().trim().min(1, 'outcome is required'),
  output: z.string().optional(),
  data: unknownRecordSchema.optional(),
});

export const manualStepSchema = z.object({
  output: z.string().trim().min(1, 'output is required'),
  outcome: optionalNonEmptyTrimmedString,
});

export const updateInteractionOutputSchema = interactionUpdateDbSchema
  .pick({
    output: true,
  })
  .extend({
    output: z.string().trim().min(1, 'output is required'),
  });

export const resetSchema = z.object({
  interactionId: nonEmptyTrimmedString,
  enqueue: z.boolean().optional(),
});
