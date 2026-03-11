import type { TaskStatus } from '@orca/types';
import type { TaskEntry, tasks } from '../db/schema';

type TaskRow = typeof tasks.$inferSelect;

export function mapTaskRow(row: TaskRow, dependsOn: string[]): TaskEntry {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? '',
    parentId: row.parentId,
    status: row.status as TaskStatus,
    autoRunOverrides: (row.autoRunOverrides ?? {}) as Record<string, boolean>,
    workflow: row.workflow,
    currentStep: row.currentStep,
    workflowSnapshot: row.workflowSnapshot ?? null,
    dependsOn,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
