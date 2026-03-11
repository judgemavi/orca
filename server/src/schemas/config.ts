import { z } from 'zod';
import { configSchema } from '../db/schema';

const configShape = configSchema.shape;
const embeddingsPatchSchema = configShape.embeddings
  .unwrap()
  .partial()
  .optional();

export const configPatchSchema = z.object({
  project: configShape.project.partial().optional(),
  tools: configShape.tools.optional(),
  orchestrator: configShape.orchestrator.partial().optional(),
  workers: configShape.workers.partial().optional(),
  monitor: configShape.monitor.partial().optional(),
  memory: configShape.memory.partial().optional(),
  postMerge: configShape.postMerge.partial().optional(),
  schemaVersion: configShape.schemaVersion.optional(),
  embeddings: embeddingsPatchSchema,
  autoRun: configShape.autoRun.optional(),
  workflows: configShape.workflows.optional(),
  logging: configShape.logging.partial().optional(),
});
