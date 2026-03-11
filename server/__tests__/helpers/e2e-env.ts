import { afterEach, beforeEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventSink } from '../../src/api/ws';
import { type DatabaseConnection, openDatabase } from '../../src/db/connection';
import { EmbeddingRegistry } from '../../src/embedding/registry';
import { Executor } from '../../src/executor/executor';
import { ToolPluginRegistry } from '../../src/plugin/registry';
import { registerJobHandlers } from '../../src/queue/handlers';
import { JobProcessor } from '../../src/queue/processor';
import { JobQueue } from '../../src/queue/queue';
import { gitRun } from '../../src/shared/git';
import * as configStoreFns from '../../src/store/config';
import { InteractionStore } from '../../src/store/interactions';
import { MemoryStore } from '../../src/store/memory';
import * as questionStoreFns from '../../src/store/questions';
import { nanoid } from 'nanoid';
import * as taskStoreFns from '../../src/store/tasks';
import type { AppDeps } from '../../src/types/deps';
import { WorkflowStore } from '../../src/workflow/store';
import { MockClaudePlugin } from './mock-plugin';

export interface E2EEnv extends AppDeps {
  conn: DatabaseConnection;
  processor: JobProcessor;
  sink: EventSink;
  events: Array<{ name: string; data: unknown }>;
  mockPlugin: MockClaudePlugin;

  // Convenience store facades backed by flat functions + conn.db
  taskStore: ReturnType<typeof makeTaskFacade>;
  configStore: ReturnType<typeof makeConfigFacade>;
  questionStore: ReturnType<typeof makeQuestionFacade>;

  startProcessor(): void;
  stopProcessor(): Promise<void>;
  waitForIdle(timeoutMs?: number): Promise<void>;
  cleanup(): Promise<void>;
}

function makeTaskFacade(conn: DatabaseConnection, sink?: EventSink) {
  const db = conn.db;
  return {
    create: async (input: Parameters<typeof taskStoreFns.createTask>[2]) => {
      const id = input.id ?? nanoid();
      await taskStoreFns.createTask(db, sink, { ...input, id });
      return taskStoreFns.getTask(db, id);
    },
    get: (id: string) => taskStoreFns.getTask(db, id),
    list: () => taskStoreFns.listTasks(db),
    listByStatus: (status: Parameters<typeof taskStoreFns.listTasks>[1]) =>
      taskStoreFns.listTasks(db, status),
    update: (id: string, fields: Parameters<typeof taskStoreFns.updateTask>[3]) =>
      taskStoreFns.updateTask(db, sink, id, fields),
    updateStatus: (id: string, status: Parameters<typeof taskStoreFns.updateTaskStatus>[3]) =>
      taskStoreFns.updateTaskStatus(db, sink, id, status),
    delete: (id: string) => taskStoreFns.deleteTask(db, sink, id),
    addDependency: (taskId: string, dependsOnId: string) =>
      taskStoreFns.addDependency(db, sink, taskId, dependsOnId),
    removeDependency: (taskId: string, dependsOnId: string) =>
      taskStoreFns.removeDependency(db, sink, taskId, dependsOnId),
    updateDependencies: (taskId: string, deps: string[]) =>
      taskStoreFns.setDependencies(db, sink, taskId, deps),
    areDependenciesMet: (taskId: string) =>
      taskStoreFns.areDependenciesMet(db, taskId),
    getReady: () => taskStoreFns.getReadyTasks(db),
    getUnblockedDependents: (mergedTaskId: string) =>
      taskStoreFns.getUnblockedDependents(db, mergedTaskId),
  };
}

function makeConfigFacade(conn: DatabaseConnection, sink?: EventSink) {
  const db = conn.db;
  return {
    load: () => configStoreFns.loadConfig(db),
    save: (config: Parameters<typeof configStoreFns.saveConfig>[2]) =>
      configStoreFns.saveConfig(db, sink, config),
    patch: async (config: Parameters<typeof configStoreFns.patchConfig>[2]) => {
      await configStoreFns.patchConfig(db, sink, config);
      return configStoreFns.loadConfig(db);
    },
  };
}

function makeQuestionFacade(conn: DatabaseConnection) {
  const db = conn.db;
  return {
    create: (input: Parameters<typeof questionStoreFns.createQuestion>[1]) =>
      questionStoreFns.createQuestion(db, input),
    get: (id: string) => questionStoreFns.getQuestion(db, id),
    answer: (id: string, answer: string) =>
      questionStoreFns.answerQuestion(db, id, answer),
    getPendingForTask: (taskId: string) =>
      questionStoreFns.getPendingForTask(db, taskId),
    listForTask: (taskId: string) =>
      questionStoreFns.listQuestionsForTask(db, taskId),
  };
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
  await Bun.$`echo ".orca/" > ${repoDir}/.gitignore`;
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
    list: () => [],
    alerts: () => [],
    since: () => [],
    subscribe: () => () => {},
  };

  const queue = new JobQueue(conn.db, sink);
  const interactionStore = new InteractionStore(
    conn.db,
    interactionLogsDir,
    sink,
  );
  const memoryStore = new MemoryStore(conn.db, sink);
  const workflowStore = new WorkflowStore();

  // Convenience facades
  const taskStore = makeTaskFacade(conn, sink);
  const configStore = makeConfigFacade(conn, sink);
  const questionStore = makeQuestionFacade(conn);

  // Registry with mock plugin
  const registry = new ToolPluginRegistry(false);
  const mockPlugin = new MockClaudePlugin();
  registry.register('claude', mockPlugin);

  // Config: set tool to claude
  await configStoreFns.patchConfig(conn.db, sink, {
    orchestrator: { tool: 'claude', model: 'mock-model' },
    project: {
      name: '',
      integrationBranch: 'orca/integration',
      worktreeDir: join(repoDir, '.orca', 'worktrees'),
    },
  });

  const config = await configStoreFns.loadConfig(conn.db);

  // Executor
  const executor = new Executor({
    config,
    registry,
    interactionStore,
    memoryStore,
    sink,
    repoDir,
    logsDir,
    queue,
    db: conn.db,
  });

  // Job processor
  const processor = new JobProcessor({
    queue,
    maxParallel: 2,
    sink,
  });

  const appDeps = {
    repoDir,
    db: conn.db,
    sink,
    registry,
    interactionStore,
    memoryStore,
    executor,
    queue,
    workflowStore,
  } satisfies AppDeps;

  registerJobHandlers(processor, appDeps);

  const waitForIdle = async (timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    let idleSince: number | null = null;
    while (Date.now() < deadline) {
      const counts = await queue.counts();
      const queued = counts.queued ?? 0;
      const running = counts.running ?? 0;
      if (queued === 0 && running === 0) {
        idleSince ??= Date.now();
        if (Date.now() - idleSince >= 200) return;
      } else {
        idleSince = null;
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
    db: conn.db,
    sink,
    queue,
    interactionStore,
    memoryStore,
    executor,
    registry,
    workflowStore,
    taskStore,
    configStore,
    questionStore,
    events,
    mockPlugin,
    processor,
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

export function setupE2EEnv(): E2EEnv {
  let env: E2EEnv | null = null;

  beforeEach(async () => {
    env = await createE2EEnv();
    env.startProcessor();
  });

  afterEach(async () => {
    if (!env) return;
    await env.cleanup();
    env = null;
  });

  return new Proxy({} as E2EEnv, {
    get(_target, prop, receiver) {
      if (!env) {
        throw new Error('E2E environment is not initialized');
      }
      return Reflect.get(env, prop, receiver);
    },
  });
}
