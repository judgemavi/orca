import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type E2EEnv, createE2EEnv } from '../helpers/e2e-env';
import type { Tool } from '../../src/mcp/types';
import { taskTools } from '../../src/mcp/tools/tasks';
import { planningTools } from '../../src/mcp/tools/planning';
import { adminTools } from '../../src/mcp/tools/admin';
import { queueTools } from '../../src/mcp/tools/queue';
import { interactionTools } from '../../src/mcp/tools/interactions';

let env: E2EEnv;
let tools: Map<string, Tool>;

const call = async (name: string, input: Record<string, unknown> = {}) => {
  const tool = tools.get(name);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  return tool.handler(input);
};

beforeEach(async () => {
  env = await createE2EEnv();
  env.startProcessor();

  const allTools: Tool[] = [
    ...taskTools({
      repoDir: env.repoDir,
      taskStore: env.taskStore,
      interactions: env.interactionStore,
      configStore: env.configStore,
      queue: env.queue,
    }),
    ...planningTools({
      configStore: env.configStore,
      taskStore: env.taskStore,
      interactions: env.interactionStore,
      queue: env.queue,
    }),
    ...adminTools({
      repoDir: env.repoDir,
      configStore: env.configStore,
      registry: env.registry,
      taskStore: env.taskStore,
      interactions: env.interactionStore,
      memory: env.memoryStore,
    }),
    ...queueTools({ queue: env.queue }),
    ...interactionTools(env.interactionStore),
  ];

  tools = new Map(allTools.map((t) => [t.name, t]));
});

afterEach(async () => {
  await env.cleanup();
});

// ---------------------------------------------------------------------------
// Schema validation: MCP tools get raw input from LLM, validation matters
// ---------------------------------------------------------------------------
describe('input validation', () => {
  test('tasks_create rejects empty title', async () => {
    await expect(call('tasks_create', { title: '' })).rejects.toThrow();
  });

  test('tasks_create rejects missing title', async () => {
    await expect(call('tasks_create', {})).rejects.toThrow();
  });

  test('tasks_get rejects empty taskId', async () => {
    await expect(call('tasks_get', { taskId: '' })).rejects.toThrow();
  });

  test('tasks_update rejects empty taskId', async () => {
    await expect(
      call('tasks_update', { taskId: '', title: 'x' }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Status transitions: MCP tasks_update validates transitions
// ---------------------------------------------------------------------------
describe('status transitions via tasks_update', () => {
  test('cannot manually set status to "merged"', async () => {
    const { task } = (await call('tasks_create', {
      title: 'Transition test',
    })) as { task: { id: string } };

    await expect(
      call('tasks_update', { taskId: task.id, status: 'merged' }),
    ).rejects.toThrow('cannot manually set status to merged');
  });

  test('cannot manually set status to "running"', async () => {
    const { task } = (await call('tasks_create', {
      title: 'No manual running',
    })) as { task: { id: string } };

    await expect(
      call('tasks_update', { taskId: task.id, status: 'running' }),
    ).rejects.toThrow('cannot manually set status to running');
  });

  test('can move failed task back to pending', async () => {
    const task = await env.taskStore.create({ title: 'Retry me' });
    await env.taskStore.updateStatus(task.id, 'failed');

    const { task: updated } = (await call('tasks_update', {
      taskId: task.id,
      status: 'pending',
    })) as { task: { status: string } };
    expect(updated.status).toBe('pending');
  });

  test('cannot move pending task to pending', async () => {
    const { task } = (await call('tasks_create', {
      title: 'Already pending',
    })) as { task: { id: string } };

    await expect(
      call('tasks_update', { taskId: task.id, status: 'pending' }),
    ).rejects.toThrow('can only move failed tasks to pending');
  });
});

// ---------------------------------------------------------------------------
// Dependency wiring via MCP
// ---------------------------------------------------------------------------
describe('dependency management', () => {
  test('tasks_create with dependsOn wires deps and skips auto-evaluate', async () => {
    const { task: dep } = (await call('tasks_create', {
      title: 'Dep',
    })) as { task: { id: string } };

    // Stop processor so evaluate for dep doesn't run
    await env.stopProcessor();

    const { task: blocked } = (await call('tasks_create', {
      title: 'Blocked',
      dependsOn: [dep.id],
    })) as { task: { id: string; dependsOn: string[] } };

    expect(blocked.dependsOn).toContain(dep.id);

    // Should NOT auto-enqueue evaluate (has deps)
    const jobs = await env.queue.list({ taskId: blocked.id });
    const evalJobs = jobs.filter((j) => j.taskId === blocked.id);
    expect(evalJobs.length).toBe(0);
  });

  test('tasks_update with dependsOn replaces deps', async () => {
    const a = await env.taskStore.create({ title: 'A' });
    const b = await env.taskStore.create({ title: 'B' });
    const c = await env.taskStore.create({ title: 'C' });
    await env.taskStore.updateDependencies(c.id, [a.id]);

    const { task } = (await call('tasks_update', {
      taskId: c.id,
      dependsOn: [b.id],
    })) as { task: { dependsOn: string[] } };

    expect(task.dependsOn).toContain(b.id);
    expect(task.dependsOn).not.toContain(a.id);
  });
});

// ---------------------------------------------------------------------------
// Plan approval via MCP
// ---------------------------------------------------------------------------
describe('plan workflow', () => {
  test('tasks_plan_set → tasks_approve_plan transitions to planned', async () => {
    const task = await env.taskStore.create({ title: 'Plan me' });

    await call('tasks_plan_set', {
      taskId: task.id,
      plan: '## Step 1\nDo something',
    });

    // Disable code autoRun so chain stops at planned
    await call('config_update', {
      patch: {
        interactions: {
          code: { tool: 'claude', model: 'mock-model', autoRun: false },
        },
      },
    });

    await call('tasks_approve_plan', { taskId: task.id });

    const final = await env.taskStore.get(task.id);
    expect(final!.status).toBe('planned');
    expect(final!.plan).toContain('Step 1');
  });

  test('tasks_approve_plan on task without plan fails', async () => {
    const task = await env.taskStore.create({ title: 'No plan' });
    await expect(
      call('tasks_approve_plan', { taskId: task.id }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Config change propagation: does config actually affect behavior?
// ---------------------------------------------------------------------------
describe('config propagation', () => {
  test('disabling code autoRun via config_update stops chain at pending w/ plan', async () => {
    await call('config_update', {
      patch: {
        interactions: {
          code: { tool: 'claude', model: 'mock-model', autoRun: false },
        },
      },
    });

    const { task } = (await call('tasks_create', {
      title: 'Config test',
    })) as { task: { id: string } };

    await env.waitForIdle(15_000);

    const final = await env.taskStore.get(task.id);
    expect(final!.status).toBe('pending');
    expect(final!.plan).toBeTruthy();

    // No code interactions should exist
    const codeIxs = await env.interactionStore.listByType(task.id, 'code');
    expect(codeIxs).toHaveLength(0);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Interaction querying: orchestrator uses this to inspect state
// ---------------------------------------------------------------------------
describe('interaction inspection', () => {
  test('interactions_list filters by type', async () => {
    const task = await env.taskStore.create({ title: 'IX filter' });
    await env.queue.enqueue({ type: 'evaluate', taskId: task.id, priority: 100 });
    await env.waitForIdle(15_000);

    const evalResult = (await call('interactions_list', {
      taskId: task.id,
      type: 'evaluate',
    })) as { interactions: Array<{ type: string }> };
    expect(evalResult.interactions.length).toBe(1);
    expect(evalResult.interactions[0].type).toBe('evaluate');

    const codeResult = (await call('interactions_list', {
      taskId: task.id,
      type: 'code',
    })) as { interactions: Array<{ type: string }> };
    expect(codeResult.interactions.length).toBe(1);
    for (const ix of codeResult.interactions) {
      expect(ix.type).toBe('code');
    }
  }, 20_000);

  test('interactions_list filters by status', async () => {
    const task = await env.taskStore.create({ title: 'Status filter' });
    await env.queue.enqueue({ type: 'evaluate', taskId: task.id, priority: 100 });
    await env.waitForIdle(15_000);

    const completed = (await call('interactions_list', {
      taskId: task.id,
      status: 'completed',
    })) as { interactions: Array<{ status: string }> };
    for (const ix of completed.interactions) {
      expect(ix.status).toBe('completed');
    }
  }, 20_000);
});
