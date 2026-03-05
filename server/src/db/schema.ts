import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    plan: text('plan'),
    sessionId: text('session_id'),
    parentId: text('parent_id'),
    status: text('status').notNull().default('pending'),
    createdAt: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
    updatedAt: text('updated_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => [
    index('idx_tasks_status').on(table.status),
    index('idx_tasks_created_at').on(table.createdAt),
    index('idx_tasks_updated_at').on(table.updatedAt),
  ],
);

export const taskDeps = sqliteTable(
  'task_deps',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    dependsOn: text('depends_on')
      .notNull()
      .references(() => tasks.id),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.dependsOn] }),
    index('idx_task_deps_depends_on').on(table.dependsOn),
  ],
);

export const taskInteractions = sqliteTable(
  'task_interactions',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    attempt: integer('attempt').notNull().default(1),
    runId: text('run_id'),
    tool: text('tool').notNull(),
    model: text('model'),
    logPath: text('log_path').notNull(),
    status: text('status').notNull().default('running'),
    error: text('error'),
    diff: text('diff'),
    exitCode: integer('exit_code'),
    durationMs: integer('duration_ms'),
    qualityJson: text('quality_json'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    estimatedCost: real('estimated_cost').notNull().default(0),
    startedAt: text('started_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
    finishedAt: text('finished_at'),
  },
  (table) => [
    index('idx_interactions_task_type').on(table.taskId, table.type),
    index('idx_interactions_status').on(table.status),
    index('idx_interactions_run_id').on(table.runId),
  ],
);

export const taskReviews = sqliteTable(
  'task_reviews',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    interactionId: text('interaction_id').references(
      () => taskInteractions.id,
      {
        onDelete: 'set null',
      },
    ),
    feedback: text('feedback').notNull(),
    status: text('status').notNull().default('pending'),
    createdAt: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
    addressedAt: text('addressed_at'),
  },
  (table) => [
    index('idx_task_reviews_task_created').on(table.taskId, table.createdAt),
  ],
);

export const taskFileAssociations = sqliteTable(
  'task_file_associations',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    filePath: text('file_path').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.filePath] }),
    index('idx_tfa_file_path').on(table.filePath),
  ],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    tool: text('tool').notNull(),
    taskId: text('task_id'),
    pid: integer('pid').notNull(),
    workingDir: text('working_dir'),
    cols: integer('cols').notNull().default(80),
    rows: integer('rows').notNull().default(24),
    status: text('status').notNull().default('running'),
    exitCode: integer('exit_code').notNull().default(-1),
    createdAt: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
    exitedAt: text('exited_at'),
  },
  (table) => [
    index('idx_sessions_status_created').on(table.status, table.createdAt),
  ],
);

export const interactions = sqliteTable(
  'interactions',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    targetId: text('target_id').notNull(),
    status: text('status').notNull().default('running'),
    result: text('result'),
    error: text('error'),
    createdAt: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
    updatedAt: text('updated_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => [
    index('idx_interactions_target').on(table.targetId, table.updatedAt),
  ],
);

export const config = sqliteTable('config', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const meta = sqliteTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const memoryEntries = sqliteTable(
  'memory_entries',
  {
    id: text('id').primaryKey(),
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
    stale: integer('stale', { mode: 'boolean' }).notNull().default(false),
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
      sql`${table.category} IN ('pattern', 'pitfall', 'preference', 'convention', 'architecture', 'dependency')`,
    ),
    check(
      'memory_source_type_check',
      sql`${table.sourceType} IN ('retro', 'explore')`,
    ),
  ],
);

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

export const exploreContext = sqliteTable(
  'explore_context',
  {
    id: integer('id').primaryKey(),
    content: text('content').notNull(),
    hash: text('hash').notNull(),
    updatedAt: text('updated_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => [check('explore_context_singleton', sql`${table.id} = 1`)],
);

export const changelog = sqliteTable(
  '_changelog',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tableName: text('table_name').notNull(),
    rowId: text('row_id').notNull(),
    action: text('action').notNull(),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [index('idx_changelog_id').on(table.id)],
);

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    taskId: text('task_id'),
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
