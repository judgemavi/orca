// Bridges WS events to react-query cache. Keeps UI in sync without polling.

import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type {
  Config,
  Interaction,
  KnownWSEvent,
  Task,
  WSEvent,
} from '../types';
import { isKnownWSEvent } from '../types';
import { queryKeys } from './queryKeys';

type TasksCache = Task[];

const INVALIDATE_EXACT: Record<string, readonly QueryKey[]> = {
  'session.created': [queryKeys.sessions],
  'session.exited': [queryKeys.sessions],
  'merge.started': [queryKeys.operations(), queryKeys.status],
  'merge.progress': [queryKeys.operations(), queryKeys.status],
  'merge.failed': [queryKeys.operations(), queryKeys.status],
};

const SIGNAL_PREFIXES = [
  'run.',
  'breakdown.',
  'cleanup.',
  'explore.',
  'evaluate.',
];

const QUEUE_EVENT_PREFIXES = ['queue.job.'];

function getTaskID(data: Record<string, unknown>): string | undefined {
  const taskID = data.taskId;
  if (typeof taskID === 'string' && taskID.length > 0) return taskID;

  const id = data.id;
  if (typeof id === 'string' && id.length > 0) return id;

  return undefined;
}

function getTaskIDFromUnknown(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  return getTaskID(data as Record<string, unknown>);
}

function getTaskIDs(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [];
  const rec = data as Record<string, unknown>;
  const single = getTaskID(rec);
  if (single) return [single];
  const arr = rec.taskIds;
  if (Array.isArray(arr))
    return arr.filter(
      (v): v is string => typeof v === 'string' && v.length > 0,
    );
  return [];
}

function isTaskData(data: unknown): data is Task {
  if (!data || typeof data !== 'object') return false;
  return 'id' in data && 'title' in data;
}

function isInteractionData(data: unknown): data is Interaction {
  if (!data || typeof data !== 'object') return false;
  return 'id' in data && 'phase' in data;
}

function upsertTask(qc: QueryClient, task: Task) {
  qc.setQueryData<TasksCache>(queryKeys.tasks, (old) => {
    const tasks = old ?? [];
    if (tasks.some((t) => t.id === task.id)) {
      return tasks.map((t) => (t.id === task.id ? task : t));
    }
    return [...tasks, task];
  });

  qc.setQueryData<Task>(queryKeys.task(task.id), task);
}

function upsertInteraction(qc: QueryClient, interaction: Interaction) {
  const tid = interaction.taskId;
  if (!tid) return;

  qc.setQueryData<Interaction[]>(queryKeys.taskInteractions(tid), (old) => {
    const list = old ?? [];
    const idx = list.findIndex((i) => i.id === interaction.id);
    if (idx >= 0) {
      const next = [...list];
      next[idx] = interaction;
      return next;
    }
    return [...list, interaction];
  });
}

function invalidateTaskContext(qc: QueryClient, taskId: string) {
  void Promise.all([
    qc.invalidateQueries({ queryKey: queryKeys.task(taskId) }),
    qc.invalidateQueries({ queryKey: queryKeys.tasks }),
    qc.invalidateQueries({ queryKey: queryKeys.taskInteractions(taskId) }),
    qc.invalidateQueries({ queryKey: queryKeys.operations() }),
    qc.invalidateQueries({ queryKey: queryKeys.status }),
  ]);
}

function handleKnownEvent(qc: QueryClient, event: KnownWSEvent): boolean {
  switch (event.type) {
    case 'task.created':
      upsertTask(qc, event.data);
      return true;

    case 'task.updated':
      if (event.data.id === '*') {
        void Promise.all([
          qc.invalidateQueries({ queryKey: queryKeys.tasks }),
          qc.invalidateQueries({ queryKey: ['task'] }),
          qc.invalidateQueries({ queryKey: ['taskPlan'] }),
          qc.invalidateQueries({ queryKey: ['task-reviews'] }),
          qc.invalidateQueries({ queryKey: queryKeys.status }),
          qc.invalidateQueries({ queryKey: queryKeys.operations() }),
        ]);
      } else if (isTaskData(event.data)) {
        upsertTask(qc, event.data);
      }
      return true;

    case 'merge.completed':
      if (isTaskData(event.data)) {
        upsertTask(qc, event.data);
      }
      void Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.operations() }),
        qc.invalidateQueries({ queryKey: queryKeys.status }),
      ]);
      return true;

    case 'task.deleted': {
      const id = event.data.id;
      qc.setQueryData<TasksCache>(queryKeys.tasks, (old) =>
        (old ?? []).filter((t) => t.id !== id),
      );
      qc.removeQueries({ queryKey: queryKeys.task(id) });
      return true;
    }

    case 'config.updated':
      qc.setQueryData<Config>(queryKeys.config, event.data);
      return true;

    case 'plan.generating':
    case 'plan.failed':
      invalidateTaskContext(qc, event.data.taskId);
      return true;

    case 'plan.completed':
      qc.setQueryData(queryKeys.taskPlan(event.data.taskId), event.data.plan);
      invalidateTaskContext(qc, event.data.taskId);
      return true;

    case 'interaction.started':
    case 'interaction.updated':
    case 'interaction.completed':
    case 'interaction.failed': {
      const isWildcard =
        getTaskIDFromUnknown(event.data) === '*' ||
        (event.data &&
          typeof event.data === 'object' &&
          'id' in event.data &&
          (event.data as Record<string, unknown>).id === '*');
      if (isWildcard) {
        void Promise.all([
          qc.invalidateQueries({ queryKey: ['task-interactions'] }),
          qc.invalidateQueries({ queryKey: ['interaction-stubs'] }),
          qc.invalidateQueries({ queryKey: ['interaction-meta'] }),
          qc.invalidateQueries({ queryKey: queryKeys.tasks }),
          qc.invalidateQueries({ queryKey: queryKeys.operations() }),
          qc.invalidateQueries({ queryKey: queryKeys.status }),
        ]);
        return true;
      }
      if (isInteractionData(event.data)) {
        upsertInteraction(qc, event.data);
        const interaction = event.data;
        if (interaction.taskId) {
          qc.setQueryData<Interaction>(
            queryKeys.interactionMeta(interaction.taskId, interaction.id),
            interaction,
          );
        }
      }
      const tid = getTaskIDFromUnknown(event.data);
      if (tid) {
        void Promise.all([
          qc.invalidateQueries({ queryKey: queryKeys.interactionStubs(tid) }),
          qc.invalidateQueries({ queryKey: queryKeys.task(tid) }),
          qc.invalidateQueries({ queryKey: queryKeys.tasks }),
          qc.invalidateQueries({ queryKey: queryKeys.operations() }),
          qc.invalidateQueries({ queryKey: queryKeys.status }),
        ]);
      }
      return true;
    }

    case 'ai_review.failed':
    case 'ai_review.completed':
      if (event.data.taskId === '*') {
        void qc.invalidateQueries({ queryKey: ['task-reviews'] });
      } else {
        void qc.invalidateQueries({
          queryKey: queryKeys.taskReviews(event.data.taskId),
        });
      }
      return true;

    default:
      return false;
  }
}

export function handleWSEvent(qc: QueryClient, event: WSEvent) {
  if (isKnownWSEvent(event) && handleKnownEvent(qc, event)) {
    return;
  }

  const exactKeys = INVALIDATE_EXACT[event.type];
  if (exactKeys) {
    void Promise.all(
      exactKeys.map((key) => qc.invalidateQueries({ queryKey: key })),
    );
    return;
  }

  const data = event.data;
  if (event.type.startsWith('ai_review.')) {
    const tid = getTaskIDFromUnknown(data);
    if (tid)
      void qc.invalidateQueries({ queryKey: queryKeys.taskReviews(tid) });
    return;
  }

  if (event.type.startsWith('retro.')) {
    const tid = getTaskIDFromUnknown(event.data);
    const queries = [
      qc.invalidateQueries({ queryKey: queryKeys.operations() }),
      qc.invalidateQueries({ queryKey: queryKeys.status }),
    ];
    if (tid) {
      queries.push(
        qc.invalidateQueries({ queryKey: queryKeys.task(tid) }),
        qc.invalidateQueries({ queryKey: queryKeys.taskInteractions(tid) }),
        qc.invalidateQueries({ queryKey: queryKeys.interactionStubs(tid) }),
      );
    }
    if (event.type === 'retro.completed') {
      queries.push(qc.invalidateQueries({ queryKey: queryKeys.memory }));
    }
    void Promise.all(queries);
    return;
  }

  if (event.type.startsWith('memory.sync')) {
    void Promise.all([
      qc.invalidateQueries({ queryKey: queryKeys.memory }),
      qc.invalidateQueries({ queryKey: queryKeys.operations() }),
      qc.invalidateQueries({ queryKey: queryKeys.status }),
    ]);
    return;
  }

  if (QUEUE_EVENT_PREFIXES.some((p) => event.type.startsWith(p))) {
    void Promise.all([
      qc.invalidateQueries({ queryKey: queryKeys.queue }),
      qc.invalidateQueries({ queryKey: queryKeys.queueCounts }),
    ]);
    return;
  }

  if (SIGNAL_PREFIXES.some((p) => event.type.startsWith(p))) {
    const tids = getTaskIDs(event.data);
    const queries: Promise<void>[] = [
      qc.invalidateQueries({ queryKey: queryKeys.operations() }),
      qc.invalidateQueries({ queryKey: queryKeys.status }),
    ];
    if (tids.length > 0) {
      queries.push(qc.invalidateQueries({ queryKey: queryKeys.tasks }));
      for (const tid of tids) {
        queries.push(
          qc.invalidateQueries({ queryKey: queryKeys.task(tid) }),
          qc.invalidateQueries({ queryKey: queryKeys.taskInteractions(tid) }),
          qc.invalidateQueries({ queryKey: queryKeys.interactionStubs(tid) }),
        );
      }
    }
    void Promise.all(queries);
  }
}
