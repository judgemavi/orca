// Bridges SSE/WS events to react-query cache. Convention-based: parses event.type as entity.action.

import type { QueryClient } from '@tanstack/react-query';
import type { Config, Interaction, Task, WSEvent } from '../types';
import { queryKeys } from './queryKeys';

type TasksCache = Task[];

function getTaskID(data: Record<string, unknown>): string | undefined {
  const taskId = data.taskId;
  if (typeof taskId === 'string' && taskId.length > 0) return taskId;
  const id = data.id;
  if (typeof id === 'string' && id.length > 0) return id;
  return undefined;
}

function upsertTask(qc: QueryClient, task: Task) {
  qc.setQueryData<TasksCache>(queryKeys.tasks, (old) => {
    const tasks = old ?? [];
    return tasks.some((t) => t.id === task.id)
      ? tasks.map((t) => (t.id === task.id ? task : t))
      : [...tasks, task];
  });
  qc.setQueryData<Task>(queryKeys.task(task.id), task);
}

function upsertInteraction(qc: QueryClient, ix: Interaction) {
  if (!ix.taskId) return;
  qc.setQueryData<Interaction[]>(
    queryKeys.taskInteractions(ix.taskId),
    (old) => {
      const list = old ?? [];
      const idx = list.findIndex((i) => i.id === ix.id);
      if (idx >= 0) {
        const next = [...list];
        next[idx] = ix;
        return next;
      }
      return [...list, ix];
    },
  );
  qc.setQueryData<Interaction>(queryKeys.interactionMeta(ix.taskId, ix.id), ix);
}

function invalidateTaskContext(qc: QueryClient, taskId: string) {
  void Promise.all([
    qc.invalidateQueries({ queryKey: queryKeys.task(taskId) }),
    qc.invalidateQueries({ queryKey: queryKeys.tasks }),
    qc.invalidateQueries({ queryKey: queryKeys.taskInteractions(taskId) }),
    qc.invalidateQueries({ queryKey: queryKeys.interactionStubs(taskId) }),
    qc.invalidateQueries({ queryKey: queryKeys.operations() }),
    qc.invalidateQueries({ queryKey: queryKeys.status }),
  ]);
}

function isTask(d: unknown): d is Task {
  return !!d && typeof d === 'object' && 'id' in d && 'title' in d;
}

function isInteraction(d: unknown): d is Interaction {
  return !!d && typeof d === 'object' && 'id' in d && 'type' in d;
}

const TASK_SCOPED = [
  'plan',
  'evaluate',
  'breakdown',
  'run',
  'merge',
  'cleanup',
  'explore',
  'interaction',
  'ai_review',
  'retro',
];

const GLOBAL_MAP: Record<string, readonly (readonly string[])[]> = {
  session: [queryKeys.sessions],
  memory: [queryKeys.memory],
  queue: [queryKeys.queue, queryKeys.queueCounts],
  monitor: [queryKeys.status],
};

export function handleWSEvent(qc: QueryClient, event: WSEvent) {
  const { type, data } = event;
  const d = (data && typeof data === 'object' ? data : {}) as Record<
    string,
    unknown
  >;
  const tid = getTaskID(d);
  const [entity, action] = type.includes('.')
    ? [type.slice(0, type.indexOf('.')), type.slice(type.indexOf('.') + 1)]
    : [type, ''];

  // Wildcard: invalidate everything
  if (tid === '*') {
    void Promise.all([
      qc.invalidateQueries({ queryKey: queryKeys.tasks }),
      qc.invalidateQueries({ queryKey: ['task'] }),
      qc.invalidateQueries({ queryKey: ['taskPlan'] }),
      qc.invalidateQueries({ queryKey: ['task-reviews'] }),
      qc.invalidateQueries({ queryKey: ['task-interactions'] }),
      qc.invalidateQueries({ queryKey: ['interaction-stubs'] }),
      qc.invalidateQueries({ queryKey: ['interaction-meta'] }),
      qc.invalidateQueries({ queryKey: queryKeys.operations() }),
      qc.invalidateQueries({ queryKey: queryKeys.status }),
    ]);
    return;
  }

  // Direct upserts
  if (entity === 'task' && (action === 'created' || action === 'updated')) {
    if (isTask(data)) upsertTask(qc, data);
    return;
  }
  if (entity === 'task' && action === 'deleted') {
    if (tid) {
      qc.setQueryData<TasksCache>(queryKeys.tasks, (old) =>
        (old ?? []).filter((t) => t.id !== tid),
      );
      qc.removeQueries({ queryKey: queryKeys.task(tid) });
    }
    return;
  }
  if (entity === 'config' && action === 'updated') {
    qc.setQueryData<Config>(queryKeys.config, data as Config);
    return;
  }
  if (entity === 'interaction') {
    if (isInteraction(data)) upsertInteraction(qc, data);
    if (tid) invalidateTaskContext(qc, tid);
    return;
  }
  if (entity === 'plan' && action === 'completed' && tid) {
    qc.setQueryData(queryKeys.taskPlan(tid), d.plan);
    invalidateTaskContext(qc, tid);
    return;
  }
  if (entity === 'merge' && action === 'completed') {
    if (isTask(data)) upsertTask(qc, data);
    void Promise.all([
      qc.invalidateQueries({ queryKey: queryKeys.operations() }),
      qc.invalidateQueries({ queryKey: queryKeys.status }),
    ]);
    return;
  }
  if (entity === 'ai_review' && tid) {
    void qc.invalidateQueries({ queryKey: queryKeys.taskReviews(tid) });
    return;
  }
  if (entity === 'retro') {
    if (tid) invalidateTaskContext(qc, tid);
    if (action === 'completed') {
      void qc.invalidateQueries({ queryKey: queryKeys.memory });
    }
    return;
  }

  // Task-scoped prefixes
  if (TASK_SCOPED.includes(entity) && tid) {
    invalidateTaskContext(qc, tid);
    return;
  }

  // Global entity map
  const keys = GLOBAL_MAP[entity];
  if (keys) {
    void Promise.all(
      keys.map((key) => qc.invalidateQueries({ queryKey: key })),
    );
    return;
  }

  // memory.sync special case
  if (type.startsWith('memory.sync')) {
    void Promise.all([
      qc.invalidateQueries({ queryKey: queryKeys.memory }),
      qc.invalidateQueries({ queryKey: queryKeys.operations() }),
      qc.invalidateQueries({ queryKey: queryKeys.status }),
    ]);
  }
}
