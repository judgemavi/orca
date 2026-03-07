import { z } from 'zod';

// ── Shared ───────────────────────────────────────────────────────────

export const toolModelSchema = z.object({
  tool: z.string().optional(),
  model: z.string().optional(),
});

// ── Tasks ────────────────────────────────────────────────────────────

export const createTaskSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1, 'title is required'),
  description: z.string().optional().default(''),
  parentId: z.string().nullable().optional(),
  autoRunOverrides: z.record(z.string(), z.boolean()).optional(),
});

export const patchTaskSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  plan: z.string().nullable().optional(),
  status: z.string().optional(),
  sessionId: z.string().nullable().optional(),
  dependsOn: z.array(z.string()).optional(),
  autoRunOverrides: z.record(z.string(), z.boolean()).optional(),
});

export const addDepsSchema = z.object({
  dependsOn: z.string().optional(),
  dependsOnIds: z.array(z.string()).optional(),
});

export const provideInputSchema = z.object({
  answer: z.string().min(1, 'answer is required'),
});

// ── Run ──────────────────────────────────────────────────────────────

export const runRequestSchema = z.object({
  taskIds: z.array(z.string()).optional(),
  tool: z.string().optional(),
  model: z.string().optional(),
  context: z.string().optional(),
});

export const resumeSchema = z.object({
  sessionId: z.string().optional(),
  feedback: z.string().optional(),
  tool: z.string().optional(),
  model: z.string().optional(),
  context: z.string().optional(),
});

// ── Merge ────────────────────────────────────────────────────────────

export const mergeBodySchema = z.object({
  mode: z.string().optional(),
});

// ── Task Plan ────────────────────────────────────────────────────────

export const planBodySchema = z.object({
  plan: z.string().optional(),
});

export const requestPlanChangesSchema = toolModelSchema.extend({
  feedback: z.string().optional(),
  interactionId: z.string().optional(),
});

// ── Task Workflow ────────────────────────────────────────────────────

export const requestChangesSchema = toolModelSchema.extend({
  feedback: z.string().optional(),
  interactionId: z.string().optional(),
});

export const aiReviewSchema = toolModelSchema.extend({
  prompt: z.string().optional(),
});

const proposedTaskSchema = z.object({
  title: z.string(),
  description: z.string().optional().default(''),
  dependsOn: z.array(z.string()).optional(),
  dependsOnIndices: z.array(z.number()).optional().default([]),
  suggestedTool: z.string().optional().default(''),
});

export const breakdownAcceptSchema = z.object({
  interactionId: z.string().optional(),
  tasks: z.array(proposedTaskSchema).optional(),
});

export const breakdownRejectSchema = z.object({
  interactionId: z.string().optional(),
});

// ── Cleanup ──────────────────────────────────────────────────────────

export const cleanupSchema = z.object({
  dryRun: z.boolean().optional(),
});

// ── Explore ──────────────────────────────────────────────────────────

export const exploreSchema = z.object({
  query: z.string().optional(),
  tool: z.string().optional(),
  model: z.string().optional(),
});

export const exploreContextSchema = z.object({
  content: z.string().optional(),
});

// ── Memory ───────────────────────────────────────────────────────────

export const memoryUpdateSchema = z.object({
  content: z.string().optional(),
  confidence: z.number().optional(),
  category: z.string().optional(),
});

export const memoryRefreshSchema = z.object({
  entryId: z.string().optional(),
});

// ── Config ───────────────────────────────────────────────────────────

export const configPatchSchema = z.record(z.string(), z.unknown());
