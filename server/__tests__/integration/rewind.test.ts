import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { gitRun } from '../../src/shared/git';
import { resetToStep } from '../../src/workflows/rewind';
import { type TestContext, createTestContext } from '../helpers/db';

let ctx: TestContext;
let repoDir: string;
let worktreePath: string;
let taskId: string;

async function initGitRepo() {
  repoDir = await mkdtemp(join(tmpdir(), 'orca-reset-'));
  await gitRun(repoDir, ['init', '-b', 'main']);
  await gitRun(repoDir, ['config', 'user.email', 'test@test.com']);
  await gitRun(repoDir, ['config', 'user.name', 'Test']);
  await writeFile(join(repoDir, 'init.txt'), 'init');
  await gitRun(repoDir, ['add', '.']);
  await gitRun(repoDir, ['commit', '-m', 'initial']);
}

async function createWorktree(tid: string) {
  const branch = `orca/task-${tid}`;
  worktreePath = join(repoDir, '.orca', 'worktrees', `task-${tid}`);
  await gitRun(repoDir, ['worktree', 'add', '-b', branch, worktreePath]);
  await gitRun(worktreePath, ['config', 'user.email', 'test@test.com']);
  await gitRun(worktreePath, ['config', 'user.name', 'Test']);
}

async function commitFile(path: string, content: string, msg: string) {
  await writeFile(join(worktreePath, path), content);
  await gitRun(worktreePath, ['add', '-A']);
  await gitRun(worktreePath, ['commit', '-m', msg]);
  const { stdout } = await gitRun(worktreePath, ['rev-parse', 'HEAD']);
  return stdout.trim();
}

async function readFile(path: string) {
  const file = Bun.file(join(worktreePath, path));
  return file.text();
}

function deps() {
  return {
    taskStore: ctx.taskStore,
    interactionStore: ctx.interactionStore,
    queue: ctx.queue,
    repoDir,
    db: ctx.db,
  };
}

beforeEach(async () => {
  ctx = createTestContext();
  await initGitRepo();
  const task = await ctx.taskStore.create({
    title: 'Reset test task',
    description: 'test',
  });
  taskId = task.id;
  await createWorktree(taskId);
  await ctx.taskStore.update(taskId, {
    status: 'review',
    currentStep: 'review',
  });
});

afterEach(async () => {
  ctx.close();
  await rm(repoDir, { recursive: true, force: true });
});

describe('resetToStep', () => {
  test('resets to interaction with commitSha, reverts git and deletes later interactions', async () => {
    const sha1 = await commitFile('a.txt', 'version1', 'code v1');
    const code = await ctx.interactionStore.begin({
      taskId,
      type: 'code',
      tool: 'claude',
    });
    await ctx.interactionStore.finish(code.id, {
      status: 'completed',
      output: 'code output',
      commitSha: sha1,
    });

    // later interaction
    await commitFile('a.txt', 'version2', 'code v2');
    const review = await ctx.interactionStore.begin({
      taskId,
      type: 'review',
      tool: 'claude',
    });
    await ctx.interactionStore.finish(review.id, {
      status: 'completed',
      output: 'review output',
    });

    const result = await resetToStep(
      { taskId, interactionId: code.id },
      deps(),
    );

    // nextStep = oldest deleted interaction's type = 'review'
    expect(result.resetToStep).toBe('review');
    expect(result.commitSha).toBe(sha1);
    expect(result.enqueued).toBe(false);
    expect(result.status).toBe('planned');

    // task state: currentStep = next step to run (the deleted one)
    const task = await ctx.taskStore.get(taskId);
    expect(task!.currentStep).toBe('review');
    expect(task!.status).toBe('planned');

    // git state reverted to target's commitSha
    const content = await readFile('a.txt');
    expect(content).toBe('version1');

    // target kept, later interaction deleted
    const interactions = await ctx.interactionStore.list(taskId);
    expect(interactions.length).toBe(1);
    expect(interactions[0]!.id).toBe(code.id);
  });

  test('resets to non-code interaction, finds prior commitSha', async () => {
    const sha1 = await commitFile('b.txt', 'original', 'code b');
    const code = await ctx.interactionStore.begin({
      taskId,
      type: 'code',
      tool: 'claude',
    });
    await ctx.interactionStore.finish(code.id, {
      status: 'completed',
      output: 'code',
      commitSha: sha1,
    });

    // review interaction (no commitSha)
    await commitFile('b.txt', 'changed-after-review', 'post-review change');
    const review = await ctx.interactionStore.begin({
      taskId,
      type: 'review',
      tool: 'claude',
    });
    await ctx.interactionStore.finish(review.id, {
      status: 'completed',
      output: 'review output',
    });

    const result = await resetToStep(
      { taskId, interactionId: review.id },
      deps(),
    );

    // review is newest, nothing deleted → keeps task's existing currentStep
    expect(result.resetToStep).toBe('review');
    // review has no commitSha, walks back to code's sha
    expect(result.commitSha).toBe(sha1);

    const content = await readFile('b.txt');
    expect(content).toBe('original');

    // target kept, nothing newer to delete
    const interactions = await ctx.interactionStore.list(taskId);
    expect(interactions.length).toBe(2);
  });

  test('resets to plan with no prior commits, skips git revert', async () => {
    const plan = await ctx.interactionStore.begin({
      taskId,
      type: 'plan',
      tool: 'claude',
    });
    await ctx.interactionStore.finish(plan.id, {
      status: 'completed',
      output: 'plan',
    });

    const result = await resetToStep(
      { taskId, interactionId: plan.id },
      deps(),
    );

    // plan is newest, nothing deleted → keeps task's existing currentStep ('review')
    expect(result.resetToStep).toBe('review');
    expect(result.commitSha).toBeUndefined();
    expect(result.status).toBe('planned');

    const task = await ctx.taskStore.get(taskId);
    expect(task!.currentStep).toBe('review');

    // target kept
    const interactions = await ctx.interactionStore.list(taskId);
    expect(interactions.length).toBe(1);
  });

  test('enqueue=true enqueues the step', async () => {
    const plan = await ctx.interactionStore.begin({
      taskId,
      type: 'plan',
      tool: 'claude',
    });
    await ctx.interactionStore.finish(plan.id, {
      status: 'completed',
      output: 'plan',
    });

    const result = await resetToStep(
      { taskId, interactionId: plan.id, enqueue: true },
      deps(),
    );

    expect(result.enqueued).toBe(true);

    const jobs = await ctx.queue.list({ taskId });
    const queued = jobs.filter((j) => j.status === 'queued');
    expect(queued.length).toBe(1);
    expect(queued[0]!.type).toBe('review');
  });

  test('enqueue=false does not enqueue', async () => {
    const plan = await ctx.interactionStore.begin({
      taskId,
      type: 'plan',
      tool: 'claude',
    });
    await ctx.interactionStore.finish(plan.id, {
      status: 'completed',
      output: 'plan',
    });

    const result = await resetToStep(
      { taskId, interactionId: plan.id },
      deps(),
    );

    expect(result.enqueued).toBe(false);

    const jobs = await ctx.queue.list({ taskId });
    const queued = jobs.filter((j) => j.status === 'queued');
    expect(queued.length).toBe(0);
  });

  test('rejects reset on running task', async () => {
    await ctx.taskStore.update(taskId, { status: 'running' });
    const ix = await ctx.interactionStore.begin({
      taskId,
      type: 'code',
      tool: 'claude',
    });
    await ctx.interactionStore.finish(ix.id, {
      status: 'completed',
      output: 'x',
    });

    await expect(
      resetToStep({ taskId, interactionId: ix.id }, deps()),
    ).rejects.toThrow('cannot reset a running task');
  });

  test('rejects reset while interaction is in progress', async () => {
    const completed = await ctx.interactionStore.begin({
      taskId,
      type: 'plan',
      tool: 'claude',
    });
    await ctx.interactionStore.finish(completed.id, {
      status: 'completed',
      output: 'plan',
    });

    // start a running interaction
    await ctx.interactionStore.begin({
      taskId,
      type: 'code',
      tool: 'claude',
    });

    await expect(
      resetToStep({ taskId, interactionId: completed.id }, deps()),
    ).rejects.toThrow('cannot reset while an interaction is in progress');
  });

  test('rejects reset for wrong task interaction', async () => {
    const other = await ctx.taskStore.create({ title: 'Other' });
    const ix = await ctx.interactionStore.begin({
      taskId: other.id,
      type: 'code',
      tool: 'claude',
    });
    await ctx.interactionStore.finish(ix.id, {
      status: 'completed',
      output: 'x',
    });

    await expect(
      resetToStep({ taskId, interactionId: ix.id }, deps()),
    ).rejects.toThrow('interaction does not belong to this task');
  });

  test('cancels existing queue jobs on reset', async () => {
    await ctx.queue.enqueue({ type: 'review', taskId, priority: 50 });
    const ix = await ctx.interactionStore.begin({
      taskId,
      type: 'plan',
      tool: 'claude',
    });
    await ctx.interactionStore.finish(ix.id, {
      status: 'completed',
      output: 'plan',
    });

    await resetToStep({ taskId, interactionId: ix.id }, deps());

    const jobs = await ctx.queue.list({ taskId });
    const queued = jobs.filter((j) => j.status === 'queued');
    expect(queued.length).toBe(0);
    const cancelled = jobs.filter((j) => j.status === 'cancelled');
    expect(cancelled.some((j) => j.type === 'review')).toBe(true);
  });
});
