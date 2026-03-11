import { sql } from 'drizzle-orm';
import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from 'drizzle-orm/zod';
import { nanoid } from 'nanoid';
import z from 'zod';
import { workflowMachineConfigSchema } from '../workflow/types';

export const configSchema = z.object({
  project: z.object({
    name: z.string(),
    integrationBranch: z.string().trim().min(1),
    worktreeDir: z.string().trim().min(1),
  }),
  tools: z.array(z.string().trim().min(1)).min(1),
  orchestrator: z.object({
    tool: z.string().trim().min(1),
    model: z.string(),
  }),
  workers: z.object({
    maxParallel: z.number().int().min(1),
  }),
  monitor: z.object({
    stuckCheckIntervalMs: z.number().int().positive(),
    maxStuckCycles: z.number().int().min(0),
    conflictCheckIntervalMs: z.number().int().positive(),
  }),
  memory: z.object({
    enabled: z.boolean().optional(),
    retro: z.boolean().optional(),
    sync: z.boolean().optional(),
  }),
  postMerge: z.object({
    enabled: z.boolean().optional(),
  }),
  schemaVersion: z.number().int().positive().optional(),
  embeddings: z
    .object({
      provider: z.string().trim().min(1),
    })
    .catchall(z.unknown())
    .optional(),
  autoRun: z.boolean().optional(),
  workflows: z.record(z.string(), workflowMachineConfigSchema).optional(),
  logging: z.object({
    level: z.string(),
    file: z.string(),
    maxSize: z.string(),
  }),
});
export type Config = z.infer<typeof configSchema>;

export const CURRENT_SCHEMA_VERSION = 3;
export const CONFIG_KEY = 'config';
export const DEFAULT_CONFIG: Config = {
  project: {
    name: '',
    integrationBranch: 'orca/integration',
    worktreeDir: '.orca/worktrees',
  },
  tools: ['claude'],
  orchestrator: {
    tool: 'claude',
    model: '',
  },
  workers: { maxParallel: 3 },
  monitor: {
    stuckCheckIntervalMs: 60_000,
    maxStuckCycles: 10,
    conflictCheckIntervalMs: 30_000,
  },
  memory: {
    enabled: true,
    retro: true,
    sync: true,
  },
  postMerge: {
    enabled: true,
  },
  schemaVersion: CURRENT_SCHEMA_VERSION,
  logging: {
    level: 'info',
    file: '.orca/orca.log',
    maxSize: '50mb',
  },
};

export const config = sqliteTable('config', {
  key: text('key').primaryKey().default(CONFIG_KEY),
  value: text('value', { mode: 'json' })
    .$type<Config>()
    .default(DEFAULT_CONFIG)
    .notNull(),
});

type AutoRunOverrides = Record<string, boolean>;

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id')
      .primaryKey()
      .$default(() => nanoid()),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    parentId: text('parent_id'),
    status: text('status').notNull().default('pending'),
    workflow: text('workflow'),
    currentStep: text('current_step'),
    autoRunOverrides: text('auto_run_overrides', {
      mode: 'json',
    })
      .$type<AutoRunOverrides>()
      .notNull()
      .default({}),
    workflowSnapshot: text('workflow_snapshot'),
    createdAt: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
    updatedAt: text('updated_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => [
    index('idx_tasks_status').on(table.status),
    index('idx_tasks_created_at').on(table.createdAt),
    index('idx_tasks_updated_at').on(table.updatedAt),
  ],
);

export const taskSelectDbSchema = createSelectSchema(tasks);
export const taskInsertDbSchema = createInsertSchema(tasks);
export const taskUpdateDbSchema = createUpdateSchema(tasks);
export type TaskEntry = z.infer<typeof taskSelectDbSchema> & {
  autoRunOverrides: AutoRunOverrides;
  workflowSnapshot: string | null;
  dependsOn?: string[];
};
export type CreateTaskInput = z.infer<typeof taskInsertDbSchema> & {
  autoRunOverrides?: AutoRunOverrides;
  workflowSnapshot?: string | null;
  dependsOn?: string[];
};
export type UpdateTaskInput = z.infer<typeof taskUpdateDbSchema> & {
  autoRunOverrides: AutoRunOverrides;
  workflowSnapshot?: string | null;
};

export const taskDeps = sqliteTable(
  'task_deps',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    dependsOn: text('depends_on')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.dependsOn] }),
    index('idx_task_deps_depends_on').on(table.dependsOn),
  ],
);

export const taskDepsSelectDbSchema = createSelectSchema(taskDeps);
export const taskDepsInsertDbSchema = createInsertSchema(taskDeps);
export const taskDepsUpdateDbSchema = createUpdateSchema(taskDeps);
export type TaskDepsEntry = z.infer<typeof taskDepsSelectDbSchema>;
export type CreateTaskDepsInput = z.infer<typeof taskDepsInsertDbSchema>;
export type UpdateTaskDepsInput = z.infer<typeof taskDepsUpdateDbSchema>;

export const taskInteractions = sqliteTable(
  'task_interactions',
  {
    id: text('id')
      .primaryKey()
      .$default(() => nanoid()),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    attempt: integer('attempt').notNull().default(1),
    stepName: text('step_name'),
    tool: text('tool').notNull(),
    model: text('model'),
    logPath: text('log_path').notNull(),
    status: text('status').notNull().default('running'),
    error: text('error'),
    output: text('output'),
    exitCode: integer('exit_code'),
    durationMs: integer('duration_ms'),
    startedAt: text('started_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
    finishedAt: text('finished_at'),
    previousInteractionId: text('previous_interaction_id'),
    commitSha: text('commit_sha'),
    sessionId: text('session_id'),
    chainId: text('chain_id'),
  },
  (table) => [
    index('idx_interactions_task_type').on(table.taskId, table.type),
    index('idx_interactions_status').on(table.status),
    index('idx_interactions_chain').on(table.chainId),
  ],
);

export const interactionSelectDbSchema = createSelectSchema(taskInteractions);
export const interactionInsertDbSchema = createInsertSchema(taskInteractions);
export const interactionUpdateDbSchema = createUpdateSchema(taskInteractions);
export type InteractionEntry = z.infer<typeof interactionSelectDbSchema>;
export type CreateInteractionInput = z.infer<typeof interactionInsertDbSchema>;
export type UpdateInteractionInput = z.infer<typeof interactionUpdateDbSchema>;

export const taskQuestions = sqliteTable(
  'task_questions',
  {
    id: text('id')
      .primaryKey()
      .$default(() => nanoid()),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    interactionId: text('interaction_id').references(
      () => taskInteractions.id,
      {
        onDelete: 'set null',
      },
    ),
    question: text('question').notNull(),
    answer: text('answer'),
    status: text('status').notNull().default('pending'),
    createdAt: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
    answeredAt: text('answered_at'),
  },
  (table) => [
    index('idx_task_questions_task_id').on(table.taskId),
    index('idx_task_questions_status').on(table.status),
  ],
);

export const taskQuestionSelectDbSchema = createSelectSchema(taskQuestions);
export const taskQuestionInsertDbSchema = createInsertSchema(taskQuestions);
export const taskQuestionUpdateDbSchema = createUpdateSchema(taskQuestions);
export type TaskQuestionEntry = z.infer<typeof taskQuestionSelectDbSchema>;
export type CreateTaskQuestionInput = z.infer<
  typeof taskQuestionInsertDbSchema
>;
export type UpdateTaskQuestionInput = z.infer<
  typeof taskQuestionUpdateDbSchema
>;

export const meta = sqliteTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const memoryEntries = sqliteTable(
  'memory_entries',
  {
    id: text('id')
      .primaryKey()
      .$default(() => nanoid()),
    content: text('content').notNull(),
    category: text('category').notNull(),
    tags: text('tags').notNull().default('[]'),
    sourceTaskId: text('source_task_id').references(() => tasks.id, {
      onDelete: 'set null',
    }),
    sourceInteractionId: text('source_interaction_id').references(
      () => taskInteractions.id,
      {
        onDelete: 'set null',
      },
    ),
    confidence: real('confidence').notNull().default(1),
    provenanceHash: text('provenance_hash').notNull(),
    supersededBy: text('superseded_by'),
    sourceType: text('source_type').notNull().default('retro'),
    coveredAtCommit: text('covered_at_commit').notNull().default(''),
    retrievalCount: integer('retrieval_count').notNull().default(0),
    stale: integer('stale', { mode: 'boolean' }).notNull().default(false),
    decayExempt: integer('decay_exempt', { mode: 'boolean' })
      .notNull()
      .default(false),
    embedding: blob('embedding', { mode: 'buffer' }),
    createdAt: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
    updatedAt: text('updated_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => [
    index('idx_memory_category').on(table.category),
    index('idx_memory_source_task').on(table.sourceTaskId),
    index('idx_memory_superseded').on(table.supersededBy),
    index('idx_memory_provenance_hash').on(table.provenanceHash),
    check(
      'memory_category_check',
      sql`${table.category} IN ('pattern', 'pitfall', 'preference', 'convention', 'architecture', 'dependency', 'tooling')`,
    ),
    check(
      'memory_source_type_check',
      sql`${table.sourceType} IN ('retro', 'explore')`,
    ),
  ],
);

export const memoryEntrySelectDbSchema = createSelectSchema(memoryEntries);
export const memoryEntryInsertDbSchema = createInsertSchema(memoryEntries);
export const memoryEntryUpdateDbSchema = createUpdateSchema(memoryEntries);
export type MemoryEntry = z.infer<typeof memoryEntrySelectDbSchema>;
export type CreateMemoryEntryInput = z.infer<typeof memoryEntryInsertDbSchema>;
export type UpdateMemoryEntryInput = z.infer<typeof memoryEntryUpdateDbSchema>;

export const memoryFileAssociations = sqliteTable(
  'memory_file_associations',
  {
    memoryId: text('memory_id')
      .notNull()
      .references(() => memoryEntries.id, { onDelete: 'cascade' }),
    filePath: text('file_path').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.memoryId, table.filePath] }),
    index('idx_mfa_file_path').on(table.filePath),
  ],
);

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id')
      .primaryKey()
      .$default(() => nanoid()),
    type: text('type').notNull(),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('queued'),
    priority: integer('priority').notNull().default(5),
    payload: text('payload'),
    error: text('error'),
    result: text('result'),
    createdAt: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
  },
  (table) => [
    index('idx_jobs_status').on(table.status),
    index('idx_jobs_task_id').on(table.taskId),
    index('idx_jobs_priority_created').on(table.priority, table.createdAt),
  ],
);

export const jobSelectDbSchema = createSelectSchema(jobs);
export const jobInsertDbSchema = createInsertSchema(jobs);
export const jobUpdateDbSchema = createUpdateSchema(jobs);
export type JobEntry = z.infer<typeof jobSelectDbSchema>;
export type CreateJobInput = z.infer<typeof jobInsertDbSchema>;
export type UpdateJobInput = z.infer<typeof jobUpdateDbSchema>;
