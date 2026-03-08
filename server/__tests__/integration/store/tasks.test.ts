import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { TestContext } from '../../helpers/db';
import { createTestContext } from '../../helpers/db';

let ctx: TestContext;

beforeEach(() => {
  ctx = createTestContext();
});

afterEach(() => {
  ctx.close();
});

describe('TaskStore.create', () => {
  test('creates task with defaults', async () => {
    const task = await ctx.taskStore.create({ title: 'Test task' });
    expect(task.id).toBeTruthy();
    expect(task.title).toBe('Test task');
    expect(task.status).toBe('pending');
    expect(task.description).toBe('');
    expect(task.dependsOn).toEqual([]);
    expect(task.parentId).toBeNull();
  });

  test('creates task with all fields', async () => {
    const task = await ctx.taskStore.create({
      id: 'custom-id',
      title: 'Full task',
      description: 'A description',
      parentId: null,
      autoRunOverrides: { code: false },
    });
    expect(task.id).toBe('custom-id');
    expect(task.description).toBe('A description');
    expect(task.autoRunOverrides).toEqual({ code: false });
  });

  test('trims title whitespace', async () => {
    const task = await ctx.taskStore.create({ title: '  padded  ' });
    expect(task.title).toBe('padded');
  });

  test('rejects empty title', async () => {
    await expect(ctx.taskStore.create({ title: '' })).rejects.toThrow(
      'title required',
    );
  });

  test('rejects whitespace-only title', async () => {
    await expect(ctx.taskStore.create({ title: '   ' })).rejects.toThrow(
      'title required',
    );
  });
});

describe('TaskStore.get', () => {
  test('returns null for missing id', async () => {
    expect(await ctx.taskStore.get('nonexistent')).toBeNull();
  });

  test('returns created task', async () => {
    const created = await ctx.taskStore.create({ title: 'Find me' });
    const fetched = await ctx.taskStore.get(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.title).toBe('Find me');
  });
});

describe('TaskStore.list', () => {
  test('returns empty array when no tasks', async () => {
    expect(await ctx.taskStore.list()).toEqual([]);
  });

  test('returns all tasks ordered by createdAt', async () => {
    await ctx.taskStore.create({ title: 'First' });
    await ctx.taskStore.create({ title: 'Second' });
    const tasks = await ctx.taskStore.list();
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.title).toBe('First');
    expect(tasks[1]!.title).toBe('Second');
  });
});

describe('TaskStore.listByStatus', () => {
  test('filters by status', async () => {
    await ctx.taskStore.create({ title: 'Pending' });
    const t2 = await ctx.taskStore.create({ title: 'Planned' });
    await ctx.taskStore.update(t2.id, { status: 'planned' });

    const pending = await ctx.taskStore.listByStatus('pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.title).toBe('Pending');

    const planned = await ctx.taskStore.listByStatus('planned');
    expect(planned).toHaveLength(1);
    expect(planned[0]!.title).toBe('Planned');
  });
});

describe('TaskStore.update', () => {
  test('updates title', async () => {
    const task = await ctx.taskStore.create({ title: 'Original' });
    await ctx.taskStore.update(task.id, { title: 'Updated' });
    const fetched = await ctx.taskStore.get(task.id);
    expect(fetched!.title).toBe('Updated');
  });

  test('updates status', async () => {
    const task = await ctx.taskStore.create({ title: 'Task' });
    await ctx.taskStore.update(task.id, { status: 'planned' });
    const fetched = await ctx.taskStore.get(task.id);
    expect(fetched!.status).toBe('planned');
  });

  test('updates plan', async () => {
    const task = await ctx.taskStore.create({ title: 'Task' });
    await ctx.taskStore.update(task.id, { plan: 'Step 1\nStep 2' });
    expect(await ctx.taskStore.getPlan(task.id)).toBe('Step 1\nStep 2');
  });

  test('clears plan with null', async () => {
    const task = await ctx.taskStore.create({ title: 'Task' });
    await ctx.taskStore.update(task.id, { plan: 'Some plan' });
    await ctx.taskStore.update(task.id, { plan: null });
    expect(await ctx.taskStore.getPlan(task.id)).toBe('');
  });

  test('no-op when no fields provided', async () => {
    const task = await ctx.taskStore.create({ title: 'Task' });
    await ctx.taskStore.update(task.id, {});
    const fetched = await ctx.taskStore.get(task.id);
    expect(fetched!.title).toBe('Task');
  });

  test('throws for missing task', async () => {
    await expect(
      ctx.taskStore.update('missing', { title: 'X' }),
    ).rejects.toThrow('not found');
  });
});

describe('TaskStore.updateStatus', () => {
  test('returns updated task', async () => {
    const task = await ctx.taskStore.create({ title: 'Task' });
    const updated = await ctx.taskStore.updateStatus(task.id, 'planned');
    expect(updated.status).toBe('planned');
  });
});

describe('TaskStore.delete', () => {
  test('deletes pending task', async () => {
    const task = await ctx.taskStore.create({ title: 'Delete me' });
    await ctx.taskStore.delete(task.id);
    expect(await ctx.taskStore.get(task.id)).toBeNull();
  });

  test('rejects deleting running task', async () => {
    const task = await ctx.taskStore.create({ title: 'Running' });
    await ctx.taskStore.update(task.id, { status: 'running' });
    await expect(ctx.taskStore.delete(task.id)).rejects.toThrow(
      'cannot delete',
    );
  });

  test('rejects deleting merged task', async () => {
    const task = await ctx.taskStore.create({ title: 'Merged' });
    await ctx.taskStore.update(task.id, { status: 'merged' });
    await expect(ctx.taskStore.delete(task.id)).rejects.toThrow(
      'cannot delete',
    );
  });

  test('rejects deleting task with dependents', async () => {
    const a = await ctx.taskStore.create({ title: 'A' });
    const b = await ctx.taskStore.create({ title: 'B' });
    await ctx.taskStore.updateDependencies(b.id, [a.id]);
    await expect(ctx.taskStore.delete(a.id)).rejects.toThrow('depend on it');
  });

  test('throws for missing task', async () => {
    await expect(ctx.taskStore.delete('missing')).rejects.toThrow('not found');
  });
});

describe('TaskStore dependencies', () => {
  test('addDependency adds a dep', async () => {
    const a = await ctx.taskStore.create({ title: 'A' });
    const b = await ctx.taskStore.create({ title: 'B' });
    await ctx.taskStore.addDependency(b.id, a.id);
    const fetched = await ctx.taskStore.get(b.id);
    expect(fetched!.dependsOn).toEqual([a.id]);
  });

  test('updateDependencies replaces deps', async () => {
    const a = await ctx.taskStore.create({ title: 'A' });
    const b = await ctx.taskStore.create({ title: 'B' });
    const c = await ctx.taskStore.create({ title: 'C' });
    await ctx.taskStore.updateDependencies(c.id, [a.id, b.id]);
    const fetched = await ctx.taskStore.get(c.id);
    expect(fetched!.dependsOn.sort()).toEqual([a.id, b.id].sort());

    await ctx.taskStore.updateDependencies(c.id, [b.id]);
    const updated = await ctx.taskStore.get(c.id);
    expect(updated!.dependsOn).toEqual([b.id]);
  });

  test('updateDependencies deduplicates', async () => {
    const a = await ctx.taskStore.create({ title: 'A' });
    const b = await ctx.taskStore.create({ title: 'B' });
    await ctx.taskStore.updateDependencies(b.id, [a.id, a.id, a.id]);
    const fetched = await ctx.taskStore.get(b.id);
    expect(fetched!.dependsOn).toEqual([a.id]);
  });

  test('updateDependencies rejects circular dep', async () => {
    const a = await ctx.taskStore.create({ title: 'A' });
    const b = await ctx.taskStore.create({ title: 'B' });
    await ctx.taskStore.updateDependencies(b.id, [a.id]);
    await expect(
      ctx.taskStore.updateDependencies(a.id, [b.id]),
    ).rejects.toThrow('circular');
  });

  test('removeDependency removes a dep', async () => {
    const a = await ctx.taskStore.create({ title: 'A' });
    const b = await ctx.taskStore.create({ title: 'B' });
    await ctx.taskStore.addDependency(b.id, a.id);
    await ctx.taskStore.removeDependency(b.id, a.id);
    const fetched = await ctx.taskStore.get(b.id);
    expect(fetched!.dependsOn).toEqual([]);
  });
});

describe('TaskStore.areDependenciesMet', () => {
  test('returns true when no deps', async () => {
    const task = await ctx.taskStore.create({ title: 'Solo' });
    expect(await ctx.taskStore.areDependenciesMet(task.id)).toBe(true);
  });

  test('returns false when dep not merged', async () => {
    const a = await ctx.taskStore.create({ title: 'A' });
    const b = await ctx.taskStore.create({ title: 'B' });
    await ctx.taskStore.addDependency(b.id, a.id);
    expect(await ctx.taskStore.areDependenciesMet(b.id)).toBe(false);
  });

  test('returns true when dep is merged', async () => {
    const a = await ctx.taskStore.create({ title: 'A' });
    const b = await ctx.taskStore.create({ title: 'B' });
    await ctx.taskStore.addDependency(b.id, a.id);
    await ctx.taskStore.update(a.id, { status: 'merged' });
    expect(await ctx.taskStore.areDependenciesMet(b.id)).toBe(true);
  });
});

describe('TaskStore.getReady', () => {
  test('returns planned tasks with all deps merged', async () => {
    const a = await ctx.taskStore.create({ title: 'A' });
    const b = await ctx.taskStore.create({ title: 'B' });
    await ctx.taskStore.addDependency(b.id, a.id);
    await ctx.taskStore.update(b.id, { status: 'planned' });

    // a not merged yet — b should not be ready
    expect(await ctx.taskStore.getReady()).toEqual([]);

    await ctx.taskStore.update(a.id, { status: 'merged' });
    const ready = await ctx.taskStore.getReady();
    expect(ready).toHaveLength(1);
    expect(ready[0]!.id).toBe(b.id);
  });

  test('does not return pending tasks', async () => {
    await ctx.taskStore.create({ title: 'Pending' });
    expect(await ctx.taskStore.getReady()).toEqual([]);
  });
});

describe('TaskStore.getUnblockedDependents', () => {
  test('returns dependents unblocked by merge', async () => {
    const a = await ctx.taskStore.create({ title: 'A' });
    const b = await ctx.taskStore.create({ title: 'B' });
    await ctx.taskStore.addDependency(b.id, a.id);
    await ctx.taskStore.update(a.id, { status: 'merged' });

    const unblocked = await ctx.taskStore.getUnblockedDependents(a.id);
    expect(unblocked).toHaveLength(1);
    expect(unblocked[0]!.id).toBe(b.id);
  });

  test('does not return tasks with unmet deps', async () => {
    const a = await ctx.taskStore.create({ title: 'A' });
    const b = await ctx.taskStore.create({ title: 'B' });
    const c = await ctx.taskStore.create({ title: 'C' });
    await ctx.taskStore.updateDependencies(c.id, [a.id, b.id]);
    await ctx.taskStore.update(a.id, { status: 'merged' });

    // c depends on both a and b — a merged but b hasn't
    const unblocked = await ctx.taskStore.getUnblockedDependents(a.id);
    expect(unblocked).toEqual([]);
  });
});

describe('TaskStore.resolveID', () => {
  test('resolves full id', async () => {
    const task = await ctx.taskStore.create({ id: 'abc-123-def', title: 'T' });
    expect(await ctx.taskStore.resolveID(task.id)).toBe(task.id);
  });

  test('resolves prefix', async () => {
    const task = await ctx.taskStore.create({ id: 'abc-123-def', title: 'T' });
    expect(await ctx.taskStore.resolveID('abc')).toBe(task.id);
  });

  test('throws on no match', async () => {
    await expect(ctx.taskStore.resolveID('zzz')).rejects.toThrow('no task');
  });

  test('throws on ambiguous prefix', async () => {
    await ctx.taskStore.create({ id: 'abc-1', title: 'T1' });
    await ctx.taskStore.create({ id: 'abc-2', title: 'T2' });
    await expect(ctx.taskStore.resolveID('abc')).rejects.toThrow('ambiguous');
  });
});

describe('TaskStore reviews', () => {
  test('add and get pending review', async () => {
    const task = await ctx.taskStore.create({ title: 'T' });
    const reviewId = await ctx.taskStore.addReview(task.id, 'Fix the bug');
    expect(reviewId).toBeTruthy();

    const pending = await ctx.taskStore.getPendingReview(task.id);
    expect(pending).not.toBeNull();
    expect(pending!.feedback).toBe('Fix the bug');
  });

  test('addressReview clears pending', async () => {
    const task = await ctx.taskStore.create({ title: 'T' });
    const reviewId = await ctx.taskStore.addReview(task.id, 'Feedback');
    await ctx.taskStore.addressReview(reviewId);
    expect(await ctx.taskStore.getPendingReview(task.id)).toBeNull();
  });

  test('listReviews returns all reviews', async () => {
    const task = await ctx.taskStore.create({ title: 'T' });
    await ctx.taskStore.addReview(task.id, 'First');
    await ctx.taskStore.addReview(task.id, 'Second');
    const reviews = await ctx.taskStore.listReviews(task.id);
    expect(reviews).toHaveLength(2);
  });
});

describe('TaskStore file associations', () => {
  test('associate and retrieve file paths', async () => {
    const task = await ctx.taskStore.create({ title: 'T' });
    await ctx.taskStore.associateFiles(task.id, ['src/a.ts', 'src/b.ts']);
    const paths = await ctx.taskStore.getFilePaths(task.id);
    expect(paths).toEqual(['src/a.ts', 'src/b.ts']);
  });

  test('deduplicates file paths', async () => {
    const task = await ctx.taskStore.create({ title: 'T' });
    await ctx.taskStore.associateFiles(task.id, ['src/a.ts', 'src/a.ts']);
    await ctx.taskStore.associateFiles(task.id, ['src/a.ts']);
    expect(await ctx.taskStore.getFilePaths(task.id)).toEqual(['src/a.ts']);
  });

  test('findTasksByFilePaths', async () => {
    const t1 = await ctx.taskStore.create({ title: 'T1' });
    const t2 = await ctx.taskStore.create({ title: 'T2' });
    await ctx.taskStore.associateFiles(t1.id, ['src/shared.ts']);
    await ctx.taskStore.associateFiles(t2.id, ['src/other.ts']);

    const found = await ctx.taskStore.findTasksByFilePaths(['src/shared.ts']);
    expect(found).toEqual([t1.id]);
  });
});
