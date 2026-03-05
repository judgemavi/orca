import type { EventSink } from './api/ws';
import {
  sanitizeConfig,
  validateConfig,
  validateDefaults,
} from './config/config';
import { type DatabaseConnection, openDatabase } from './db/connection';
import {
  type ToolPluginRegistry,
  fallbackToolPluginRegistry,
  loadToolPluginRegistry,
} from './plugin/registry';
import { Executor } from './executor/executor';
import { JobQueue } from './queue/queue';
import { ConfigStore } from './store/config';
import { InteractionStore } from './store/interactions';
import { MemoryStore } from './store/memory';
import { TaskStore } from './store/tasks';
import type { Config } from './types';

export interface BootstrapOptions {
  repoDir: string;
  eventSink?: EventSink;
}

export interface BootstrapResult {
  database: DatabaseConnection;
  config: Config;
  registry: ToolPluginRegistry;
  configStore: ConfigStore;
  taskStore: TaskStore;
  interactionStore: InteractionStore;
  memoryStore: MemoryStore;
  queue: JobQueue;
  executor: Executor;
  repoDir: string;
}

export async function bootstrap(
  opts: BootstrapOptions,
): Promise<BootstrapResult> {
  const { repoDir, eventSink } = opts;

  const database = openDatabase({ repoDir });
  const db = database.db;

  let registry = fallbackToolPluginRegistry();
  try {
    registry = await loadToolPluginRegistry(repoDir);
  } catch (error) {
    console.warn(
      'failed to load plugin registry from .orca/plugins, using built-ins',
      error,
    );
  }

  const configStore = new ConfigStore(db, eventSink);
  const taskStore = new TaskStore(db, eventSink);
  const interactionStore = new InteractionStore(db, undefined, eventSink);
  const memoryStore = new MemoryStore(db, eventSink);
  const queue = new JobQueue(db, eventSink);

  const config = await configStore.load();
  validateConfig(config);
  const changes = sanitizeConfig(config, registry);
  validateDefaults(config, registry);
  if (changes.length > 0) {
    for (const change of changes) {
      console.warn('[config sanitized]', change);
    }
    await configStore.save(config);
  }

  const executor = new Executor({
    config,
    registry,
    taskStore,
    interactionStore,
    memoryStore,
    eventSink,
    repoDir,
    logsDir: `${repoDir}/.orca/logs`,
    queue,
  });

  return {
    database,
    config,
    registry,
    configStore,
    taskStore,
    interactionStore,
    memoryStore,
    queue,
    executor,
    repoDir,
  };
}
