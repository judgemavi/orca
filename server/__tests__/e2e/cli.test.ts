import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { type E2EEnv, createE2EEnv } from '../helpers/e2e-env';
import { registerTaskCommands } from '../../src/cli/commands/task';
import { registerConfigCommands } from '../../src/cli/commands/config';
import { registerQueueCommands } from '../../src/cli/commands/queue';
import { setJSONMode } from '../../src/cli/format';

let env: E2EEnv;
let program: Command;
let output: string[];

function captureOutput() {
  output = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  };
  return () => {
    console.log = orig;
  };
}

function lastJSON(): unknown {
  const last = output[output.length - 1];
  if (!last) return null;
  const parsed = JSON.parse(last);
  return parsed.data ?? parsed;
}

async function run(...args: string[]) {
  const restore = captureOutput();
  try {
    await program.parseAsync(['node', 'orca', ...args]);
  } finally {
    restore();
  }
  return lastJSON();
}

beforeEach(async () => {
  env = await createE2EEnv();
  env.startProcessor();
  setJSONMode(true);

  program = new Command();
  program.name('orca').exitOverride();

  const taskCmd = program.command('task').alias('t');
  registerTaskCommands(taskCmd, {
    repoDir: env.repoDir,
    taskStore: env.taskStore,
    interactionStore: env.interactionStore,
    configStore: env.configStore,
    queue: env.queue,
  });
  registerConfigCommands(program, env.configStore, env.registry);
  registerQueueCommands(program, {
    queue: env.queue,
    taskStore: env.taskStore,
  });
});

afterEach(async () => {
  setJSONMode(false);
  await env.cleanup();
});

// ---------------------------------------------------------------------------
// Orchestrator workflow: create task w/ deps via CLI flags
// ---------------------------------------------------------------------------
describe('orchestrator workflow via CLI', () => {
  test('create with --depends-on wires deps and skips auto-evaluate', async () => {
    const dep = await env.taskStore.create({ title: 'Prerequisite' });

    const created = (await run(
      'task',
      'create',
      '-t',
      'Blocked task',
      '--depends-on',
      dep.id,
    )) as Record<string, unknown>;
    expect(created.id).toBeTruthy();

    // Task should have dep wired
    const task = await env.taskStore.get(created.id as string);
    expect(task!.dependsOn).toContain(dep.id);

    // Should NOT auto-enqueue evaluate (has unmet deps)
    await new Promise((r) => setTimeout(r, 500));
    const jobs = await env.queue.list({ taskId: created.id as string });
    expect(jobs.length).toBe(0);
  });

  test('create with --disable-autorun sets per-task overrides', async () => {
    const created = (await run(
      'task',
      'create',
      '-t',
      'Manual review',
      '--disable-autorun',
      'review,merge',
    )) as Record<string, unknown>;

    const task = await env.taskStore.get(created.id as string);
    expect(task!.autoRunOverrides).toEqual({ review: false, merge: false });
  });

  test('plan set → approve-plan → chain continues from planned', async () => {
    // Disable code auto-run so chain stops at planned after approve
    await env.configStore.patch({
      interactions: {
        code: { tool: 'claude', model: 'mock-model', autoRun: false },
      },
    });

    const task = await env.taskStore.create({ title: 'Plan flow' });

    await run('task', 'plan', 'set', task.id, '--text', '## Step 1\nDo X');
    await run('task', 'approve-plan', task.id);

    const updated = await env.taskStore.get(task.id);
    expect(updated!.status).toBe('planned');
    expect(updated!.plan).toContain('Step 1');
  });

  test('deps add/remove modifies task dependencies', async () => {
    const a = await env.taskStore.create({ title: 'A' });
    const b = await env.taskStore.create({ title: 'B' });

    await run('task', 'deps', 'add', b.id, a.id);
    let task = await env.taskStore.get(b.id);
    expect(task!.dependsOn).toContain(a.id);

    await run('task', 'deps', 'remove', b.id, a.id);
    task = await env.taskStore.get(b.id);
    expect(task!.dependsOn).not.toContain(a.id);
  });

  test('interactions --type filters by interaction type', async () => {
    const task = await env.taskStore.create({ title: 'Filter test' });
    await env.queue.enqueue({ type: 'evaluate', taskId: task.id, priority: 100 });
    await env.waitForIdle(15_000);

    const evalOnly = (await run(
      'task',
      'interactions',
      task.id,
      '--type',
      'evaluate',
    )) as Array<{ type: string }>;
    expect(evalOnly.length).toBe(1);
    expect(evalOnly[0].type).toBe('evaluate');

    const planOnly = (await run(
      'task',
      'interactions',
      task.id,
      '--type',
      'plan',
    )) as Array<{ type: string }>;
    expect(planOnly.length).toBe(1);
    expect(planOnly[0].type).toBe('plan');
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Error handling: orchestrator needs clear errors
// ---------------------------------------------------------------------------
describe('CLI error handling', () => {
  test('get nonexistent task throws with "not found"', async () => {
    await expect(run('task', 'get', 'ghost-id')).rejects.toThrow('not found');
  });

  test('delete nonexistent task throws with "not found"', async () => {
    await expect(
      run('task', 'delete', 'ghost-id', '-y'),
    ).rejects.toThrow('not found');
  });

  test('approve-plan on task without plan fails', async () => {
    const task = await env.taskStore.create({ title: 'No plan' });
    await expect(run('task', 'approve-plan', task.id)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// JSON output contract: orchestrator parses this
// ---------------------------------------------------------------------------
describe('JSON output contract', () => {
  test('task create output includes all fields orchestrator needs', async () => {
    const result = (await run(
      'task',
      'create',
      '-t',
      'Contract test',
      '-d',
      'Description',
    )) as Record<string, unknown>;

    // Orchestrator relies on these fields
    expect(typeof result.id).toBe('string');
    expect(result.title).toBe('Contract test');
    expect(result.description).toBe('Description');
    expect(result.status).toBe('pending');
    expect(Array.isArray(result.dependsOn)).toBe(true);
    expect(result).toHaveProperty('createdAt');
  });

  test('task list returns array with status field', async () => {
    await env.taskStore.create({ title: 'A' });
    await env.taskStore.create({ title: 'B' });

    const listed = (await run('task', 'list')) as Array<
      Record<string, unknown>
    >;
    expect(listed.length).toBe(2);
    for (const t of listed) {
      expect(typeof t.id).toBe('string');
      expect(typeof t.status).toBe('string');
      expect(typeof t.title).toBe('string');
    }
  });

  test('queue counts output shape', async () => {
    const task = await env.taskStore.create({ title: 'Q' });
    await env.stopProcessor();
    await env.queue.enqueue({ type: 'evaluate', taskId: task.id, priority: 100 });

    const counts = (await run('queue', 'counts')) as Record<string, number>;
    expect(counts.queued).toBe(1);
  });
});
