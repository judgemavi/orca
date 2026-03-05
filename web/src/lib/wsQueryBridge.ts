// Bridges SSE/WS events to react-query cache. Convention-based: parses event.type as entity.action.

import type { QueryClient } from '@tanstack/react-query';
import type { Config, Interaction, Task, WSEvent } from '../types';
import { queryKeys } from './queryKeys';

type TasksCache = Task[];

// ── db changelog handling ────────────────────────────────────────────
// The db-poller reads the _changelog table and broadcasts db.insert,
// db.update, db.delete with { table, ids }. We debounce and batch.

const DB_DEBOUNCE_MS = 400;
let dbTimer: ReturnType<typeof setTimeout> | null = null;

interface PendingChanges {
  inserts: Map<string, Set<string>>;
  updates: Map<string, Set<string>>;
  deletes: Map<string, Set<string>>;
}

const pending: PendingChanges = {
  inserts: new Map(),
  updates: new Map(),
  deletes: new Map(),
};

function addPending(
  map: Map<string, Set<string>>,
  table: string,
  ids: string[],
) {
  let set = map.get(table);
  if (!set) {
    set = new Set();
    map.set(table, set);
  }
  for (const id of ids) set.add(id);
}

const LIST_KEYS: Record<string, readonly (readonly unknown[])[]> = {
  tasks: [queryKeys.tasks],
  task_interactions: [],
  task_reviews: [],
  jobs: [queryKeys.queue, queryKeys.queueCounts],
  memory_entries: [queryKeys.memory],
  config: [queryKeys.config],
};

function flushDbChanges(qc: QueryClient) {
  dbTimer = null;
  const { inserts, updates, deletes } = pending;

  // Collect all tables that had any change
  const allTables = new Set([
    ...inserts.keys(),
    ...updates.keys(),
    ...deletes.keys(),
  ]);

  for (const table of allTables) {
    const insertIds = inserts.get(table);
    const updateIds = updates.get(table);
    const deleteIds = deletes.get(table);
    const hasInsert = insertIds && insertIds.size > 0;
    const hasDelete = deleteIds && deleteIds.size > 0;
    const hasUpdate = updateIds && updateIds.size > 0;

    // List-level: always invalidate on insert or delete
    if (hasInsert || hasDelete) {
      const keys = LIST_KEYS[table];
      if (keys) {
        for (const key of keys) {
          void qc.invalidateQueries({ queryKey: key });
        }
      }
    }

    // Item-level: invalidate on update (and insert for good measure)
    if (hasUpdate || hasInsert) {
      const ids = new Set<string>();
      if (updateIds) for (const id of updateIds) ids.add(id);
      if (insertIds) for (const id of insertIds) ids.add(id);

      if (table === 'tasks') {
        // Also invalidate list so status badges etc update
        void qc.invalidateQueries({ queryKey: queryKeys.tasks });
        for (const id of ids) {
          void qc.invalidateQueries({ queryKey: queryKeys.task(id) });
          void qc.invalidateQueries({
            queryKey: queryKeys.interactionStubs(id),
          });
        }
      } else if (table === 'task_interactions') {
        // Interactions don't have a direct id→taskId mapping in the event,
        // so invalidate all interaction-related queries
        void qc.invalidateQueries({ queryKey: queryKeys.operations() });
        void qc.invalidateQueries({ queryKey: ['task-interactions'] });
        void qc.invalidateQueries({ queryKey: ['interaction-stubs'] });
        void qc.invalidateQueries({ queryKey: ['interaction-meta'] });
      } else if (table === 'task_reviews') {
        void qc.invalidateQueries({ queryKey: ['task-reviews'] });
      } else if (table === 'jobs') {
        void qc.invalidateQueries({ queryKey: queryKeys.queue });
        void qc.invalidateQueries({ queryKey: queryKeys.queueCounts });
      } else if (table === 'memory_entries') {
        void qc.invalidateQueries({ queryKey: queryKeys.memory });
      } else if (table === 'config') {
        void qc.invalidateQueries({ queryKey: queryKeys.config });
      }
    }
  }

  // Clear pending
  inserts.clear();
  updates.clear();
  deletes.clear();
}

function scheduleDbFlush(qc: QueryClient) {
  if (dbTimer) return;
  dbTimer = setTimeout(() => flushDbChanges(qc), DB_DEBOUNCE_MS);
}

// ── helpers ──────────────────────────────────────────────────────────

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

  // db changelog events — batch and debounce
  if (
    entity === 'db' &&
    (action === 'insert' || action === 'update' || action === 'delete')
  ) {
    const table = typeof d.table === 'string' ? d.table : '';
    const ids = Array.isArray(d.ids) ? (d.ids as string[]) : [];
    if (table && ids.length > 0) {
      const map =
        action === 'insert'
          ? pending.inserts
          : action === 'delete'
            ? pending.deletes
            : pending.updates;
      addPending(map, table, ids);
      scheduleDbFlush(qc);
    }
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
