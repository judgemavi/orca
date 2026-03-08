import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { EventSink } from '../../src/api/ws';
import { type DatabaseConnection, openDatabase } from '../../src/db/connection';
import { EmbeddingRegistry } from '../../src/embedding/registry';
import { Executor } from '../../src/executor/executor';
import { ToolPluginRegistry } from '../../src/plugin/registry';
import { registerJobHandlers } from '../../src/queue/handlers';
import { JobProcessor } from '../../src/queue/processor';
import { JobQueue } from '../../src/queue/queue';
import { gitRun } from '../../src/shared/git';
import { ConfigStore } from '../../src/store/config';
import { InteractionStore } from '../../src/store/interactions';
import { MemoryStore } from '../../src/store/memory';
import { TaskStore } from '../../src/store/tasks';
import { MockClaudePlugin } from './mock-plugin';

export interface E2EEnv {
  repoDir: string;
  conn: DatabaseConnection;
  taskStore: TaskStore;
  queue: JobQueue;
  configStore: ConfigStore;
  interactionStore: InteractionStore;
  memoryStore: MemoryStore;
  executor: Executor;
  processor: JobProcessor;
  registry: ToolPluginRegistry;
  sink: EventSink;
  events: Array<{ name: string; data: unknown }>;

  /** Start the job processor polling loop */
  startProcessor(): void;
  /** Stop processor and wait for in-flight jobs */
  stopProcessor(): Promise<void>;
  /** Wait until no queued/running jobs remain (with timeout) */
  waitForIdle(timeoutMs?: number): Promise<void>;
  /** Tear down everything */
  cleanup(): Promise<void>;
}

export async function createE2EEnv(): Promise<E2EEnv> {
  const repoDir = await mkdtemp(join(tmpdir(), 'orca-e2e-'));
  const logsDir = join(repoDir, '.orca', 'logs');
  const interactionLogsDir = join(repoDir, '.orca', 'interaction-logs');

  // Init real git repo with an initial commit
  await Bun.$`mkdir -p ${logsDir} ${interactionLogsDir}`;
  await gitRun(repoDir, ['init']);
  await gitRun(repoDir, ['config', 'user.email', 'test@orca.dev']);
  await gitRun(repoDir, ['config', 'user.name', 'Orca Test']);
  await Bun.$`echo "# test repo" > ${repoDir}/README.md`;
  await gitRun(repoDir, ['add', '-A']);
  await gitRun(repoDir, ['commit', '-m', 'initial commit']);
  // Create integration branch
  await gitRun(repoDir, ['branch', 'orca/integration']);

  // In-memory SQLite
  const conn = openDatabase({ repoDir: '', dbPath: ':memory:' });

  // Event capture
  const events: Array<{ name: string; data: unknown }> = [];
  const sink: EventSink = {
    broadcast: (name: string, data?: unknown) => {
      events.push({ name, data });
    },
    close: () => {},
  } as EventSink;

  // Stores
  const taskStore = new TaskStore(conn.db, sink);
  const queue = new JobQueue(conn.db, sink);
  const configStore = new ConfigStore(conn.db);
  const interactionStore = new InteractionStore(
    conn.db,
    interactionLogsDir,
    sink,
  );
  const memoryStore = new MemoryStore(conn.db, sink);

  // Registry with mock plugin
  const registry = new ToolPluginRegistry(false);
  registry.register('claude', new MockClaudePlugin());

  // Config: enable auto-run for all types, set tool to claude
  await configStore.patch({
    interactions: {
      evaluate: { tool: 'claude', model: 'mock-model', autoRun: true },
      plan: { tool: 'claude', model: 'mock-model', autoRun: true },
      code: { tool: 'claude', model: 'mock-model', autoRun: true },
      review: { tool: 'claude', model: 'mock-model', autoRun: true },
      merge: { tool: 'claude', model: 'mock-model', autoRun: true },
      retro: { tool: 'claude', model: 'mock-model', autoRun: true },
      breakdown: { tool: 'claude', model: 'mock-model', autoRun: true },
    },
    project: {
      integrationBranch: 'orca/integration',
      worktreeDir: '',
    },
  });

  const config = await configStore.load();

  // Executor
  const executor = new Executor({
    config,
    registry,
    taskStore,
    interactionStore,
    memoryStore,
    eventSink: sink,
    repoDir,
    logsDir,
    queue,
  });

  // Job processor
  const processor = new JobProcessor({
    queue,
    maxParallel: 2,
    sink,
  });

  registerJobHandlers(processor, {
    repoDir,
    configStore,
    registry,
    taskStore,
    interactionStore,
    memoryStore,
    executor,
    sink,
    queue,
  });

  const waitForIdle = async (timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    let sawActivity = false;
    while (Date.now() < deadline) {
      const counts = await queue.counts();
      const queued = counts.queued ?? 0;
      const running = counts.running ?? 0;
      if (queued > 0 || running > 0) sawActivity = true;
      if (sawActivity && queued === 0 && running === 0) {
        // Settle: wait a bit for any chain-enqueued follow-up jobs
        await new Promise((r) => setTimeout(r, 200));
        const recheck = await queue.counts();
        if (!recheck.queued && !recheck.running) return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    const counts = await queue.counts();
    throw new Error(
      `waitForIdle timeout: queued=${counts.queued ?? 0} running=${counts.running ?? 0}`,
    );
  };

  return {
    repoDir,
    conn,
    taskStore,
    queue,
    configStore,
    interactionStore,
    memoryStore,
    executor,
    processor,
    registry,
    sink,
    events,
    startProcessor: () => processor.start(),
    stopProcessor: () => processor.stop(),
    waitForIdle,
    cleanup: async () => {
      await processor.stop().catch(() => {});
      conn.close();
      await rm(repoDir, { recursive: true, force: true });
    },
  };
}
