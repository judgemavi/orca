import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { OrcaDrizzleDB } from '../../../src/db/connection';
import {
  addDependency,
  areDependenciesMet,
  createTask,
  deleteTask,
  getReadyTasks,
  getTask,
  getUnblockedDependents,
  listTasks,
  removeDependency,
  setDependencies,
  updateTask,
  updateTaskStatus,
} from '../../../src/store/tasks';
import { createTestDB } from '../../helpers/db';

let db: OrcaDrizzleDB;
let closeFn: () => void;

beforeEach(() => {
  const conn = createTestDB();
  db = conn.db;
  closeFn = conn.close;
});

afterEach(() => {
  closeFn();
});

describe('TaskStore.create', () => {
  test('creates task with defaults', async () => {
    const id = 'task-defaults';
    await createTask(db, undefined, { id, title: 'Test task' });
    const task = await getTask(db, id);
    expect(task.id).toBe(id);
    expect(task.title).toBe('Test task');
    expect(task.status).toBe('pending');
    expect(task.description).toBe('');
    expect(task.dependsOn).toEqual([]);
    expect(task.parentId).toBeNull();
  });

  test('creates task with all fields', async () => {
    await createTask(db, undefined, {
      id: 'custom-id',
      title: 'Full task',
      description: 'A description',
      parentId: null,
      autoRunOverrides: { code: false },
    });
    const task = await getTask(db, 'custom-id');
    expect(task.id).toBe('custom-id');
    expect(task.description).toBe('A description');
    expect(task.autoRunOverrides).toEqual({ code: false });
  });

  test('creates task with dependencies on the new task', async () => {
    await createTask(db, undefined, { id: 'dep-a', title: 'A' });
    await createTask(db, undefined, {
      id: 'dep-b',
      title: 'B',
      dependsOn: ['dep-a'],
    });

    const fetched = await getTask(db, 'dep-b');
    expect(fetched.dependsOn).toEqual(['dep-a']);
  });

});

describe('TaskStore.get', () => {
  test('throws for missing id', async () => {
    await expect(getTask(db, 'nonexistent')).rejects.toThrow('not found');
  });

  test('returns created task', async () => {
    await createTask(db, undefined, { id: 'find-me', title: 'Find me' });
    const fetched = await getTask(db, 'find-me');
    expect(fetched.id).toBe('find-me');
    expect(fetched.title).toBe('Find me');
  });
});

describe('TaskStore.list', () => {
  test('returns all tasks ordered by createdAt', async () => {
    await createTask(db, undefined, { title: 'First' });
    await createTask(db, undefined, { title: 'Second' });
    const tasks = await listTasks(db);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.title).toBe('First');
    expect(tasks[1]!.title).toBe('Second');
  });

  test('includes dependencies for each task', async () => {
    await createTask(db, undefined, { id: 'list-a', title: 'A' });
    await createTask(db, undefined, { id: 'list-b', title: 'B' });
    await addDependency(db, undefined, 'list-b', 'list-a');

    const tasks = await listTasks(db);
    const dependent = tasks.find((task) => task.id === 'list-b');

    expect(dependent?.dependsOn).toEqual(['list-a']);
  });
});

describe('TaskStore.listByStatus', () => {
  test('filters by status', async () => {
    await createTask(db, undefined, { title: 'Pending' });
    await createTask(db, undefined, { id: 'task-planned', title: 'Planned' });
    await updateTask(db, undefined, 'task-planned', { status: 'planned' });

    const pending = await listTasks(db, 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.title).toBe('Pending');

    const planned = await listTasks(db, 'planned');
    expect(planned).toHaveLength(1);
    expect(planned[0]!.title).toBe('Planned');
  });
});

describe('TaskStore.update', () => {
  test('updates title', async () => {
    await createTask(db, undefined, { id: 'upd-title', title: 'Original' });
    await updateTask(db, undefined, 'upd-title', { title: 'Updated' });
    const fetched = await getTask(db, 'upd-title');
    expect(fetched.title).toBe('Updated');
  });

  test('updates status', async () => {
    await createTask(db, undefined, { id: 'upd-status', title: 'Task' });
    await updateTask(db, undefined, 'upd-status', { status: 'planned' });
    const fetched = await getTask(db, 'upd-status');
    expect(fetched.status).toBe('planned');
  });

  test('getStepOutput reads output from interaction output field', async () => {
    const { getStepOutput } = await import('../../../src/workflow/context');
    const { InteractionStore } = await import('../../../src/store/interactions');
    const interactionStore = new InteractionStore(db);
    await createTask(db, undefined, { id: 'step-out', title: 'Task' });
    // No interaction → empty
    expect(await getStepOutput('step-out', 'plan', interactionStore)).toBe('');
    // Create plan interaction (type=context, stepName=plan matches workflow preset)
    const ix = await interactionStore.begin({
      taskId: 'step-out',
      type: 'context',
      stepName: 'plan',
      tool: 'test',
    });
    await interactionStore.finish(ix.id, {
      status: 'completed',
      output: JSON.stringify({ result: 'approved', output: 'Step 1\nStep 2' }),
    });
    expect(await getStepOutput('step-out', 'plan', interactionStore)).toBe(
      'Step 1\nStep 2',
    );
  });

  test('no-op when no fields provided', async () => {
    await createTask(db, undefined, { id: 'noop', title: 'Task' });
    await updateTask(db, undefined, 'noop', {});
    const fetched = await getTask(db, 'noop');
    expect(fetched.title).toBe('Task');
  });
});

describe('TaskStore.updateStatus', () => {
  test('updates task status', async () => {
    await createTask(db, undefined, { id: 'upd-st', title: 'Task' });
    await updateTaskStatus(db, undefined, 'upd-st', 'planned');
    const fetched = await getTask(db, 'upd-st');
    expect(fetched.status).toBe('planned');
  });
});

describe('TaskStore.delete', () => {
  test('deletes pending task', async () => {
    await createTask(db, undefined, { id: 'del-me', title: 'Delete me' });
    await deleteTask(db, undefined, 'del-me');
    await expect(getTask(db, 'del-me')).rejects.toThrow('not found');
  });
});

describe('TaskStore dependencies', () => {
  test('addDependency adds a dep', async () => {
    await createTask(db, undefined, { id: 'dep-a', title: 'A' });
    await createTask(db, undefined, { id: 'dep-b', title: 'B' });
    await addDependency(db, undefined, 'dep-b', 'dep-a');
    const fetched = await getTask(db, 'dep-b');
    expect(fetched.dependsOn).toEqual(['dep-a']);
  });

  test('setDependencies replaces deps', async () => {
    await createTask(db, undefined, { id: 'sd-a', title: 'A' });
    await createTask(db, undefined, { id: 'sd-b', title: 'B' });
    await createTask(db, undefined, { id: 'sd-c', title: 'C' });
    await setDependencies(db, undefined, 'sd-c', ['sd-a', 'sd-b']);
    const fetched = await getTask(db, 'sd-c');
    expect((fetched.dependsOn ?? []).sort()).toEqual(['sd-a', 'sd-b'].sort());

    await setDependencies(db, undefined, 'sd-c', ['sd-b']);
    const updated = await getTask(db, 'sd-c');
    expect(updated.dependsOn).toEqual(['sd-b']);
  });

  test('removeDependency removes a dep', async () => {
    await createTask(db, undefined, { id: 'rm-a', title: 'A' });
    await createTask(db, undefined, { id: 'rm-b', title: 'B' });
    await addDependency(db, undefined, 'rm-b', 'rm-a');
    await removeDependency(db, undefined, 'rm-b', 'rm-a');
    const fetched = await getTask(db, 'rm-b');
    expect(fetched.dependsOn).toEqual([]);
  });
});

describe('TaskStore.areDependenciesMet', () => {
  test('returns true when no deps', async () => {
    await createTask(db, undefined, { id: 'solo', title: 'Solo' });
    expect(await areDependenciesMet(db, 'solo')).toBe(true);
  });

  test('returns false when dep not merged', async () => {
    await createTask(db, undefined, { id: 'amd-a', title: 'A' });
    await createTask(db, undefined, { id: 'amd-b', title: 'B' });
    await addDependency(db, undefined, 'amd-b', 'amd-a');
    expect(await areDependenciesMet(db, 'amd-b')).toBe(false);
  });

  test('returns true when dep is merged', async () => {
    await createTask(db, undefined, { id: 'amd-ma', title: 'A' });
    await createTask(db, undefined, { id: 'amd-mb', title: 'B' });
    await addDependency(db, undefined, 'amd-mb', 'amd-ma');
    await updateTask(db, undefined, 'amd-ma', { status: 'merged' });
    expect(await areDependenciesMet(db, 'amd-mb')).toBe(true);
  });
});

describe('TaskStore.getReady', () => {
  test('returns planned tasks with all deps merged', async () => {
    await createTask(db, undefined, { id: 'gr-a', title: 'A' });
    await createTask(db, undefined, { id: 'gr-b', title: 'B' });
    await addDependency(db, undefined, 'gr-b', 'gr-a');
    await updateTask(db, undefined, 'gr-b', { status: 'planned' });

    // a not merged yet — b should not be ready
    expect(await getReadyTasks(db)).toEqual([]);

    await updateTask(db, undefined, 'gr-a', { status: 'merged' });
    const ready = await getReadyTasks(db);
    expect(ready).toHaveLength(1);
    expect(ready[0]!.id).toBe('gr-b');
  });

  test('does not return pending tasks', async () => {
    await createTask(db, undefined, { id: 'gr-p', title: 'Pending' });
    expect(await getReadyTasks(db)).toEqual([]);
  });
});

describe('TaskStore.getUnblockedDependents', () => {
  test('returns dependents unblocked by merge', async () => {
    await createTask(db, undefined, { id: 'ubd-a', title: 'A' });
    await createTask(db, undefined, { id: 'ubd-b', title: 'B' });
    await addDependency(db, undefined, 'ubd-b', 'ubd-a');
    await updateTask(db, undefined, 'ubd-a', { status: 'merged' });

    const unblocked = await getUnblockedDependents(db, 'ubd-a');
    expect(unblocked).toHaveLength(1);
    expect(unblocked[0]!.id).toBe('ubd-b');
  });

  test('does not return tasks with unmet deps', async () => {
    await createTask(db, undefined, { id: 'ubd-x', title: 'A' });
    await createTask(db, undefined, { id: 'ubd-y', title: 'B' });
    await createTask(db, undefined, { id: 'ubd-z', title: 'C' });
    await setDependencies(db, undefined, 'ubd-z', ['ubd-x', 'ubd-y']);
    await updateTask(db, undefined, 'ubd-x', { status: 'merged' });

    // z depends on both x and y — x merged but y hasn't
    const unblocked = await getUnblockedDependents(db, 'ubd-x');
    expect(unblocked).toEqual([]);
  });
});
