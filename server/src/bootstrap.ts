import type { EventSink } from './api/ws';
import { sanitizeConfig, validateDefaults } from './config/config';
import { type DatabaseConnection, openDatabase } from './db/connection';
import type { Config } from './db/schema';
import {
  type EmbeddingRegistry,
  loadEmbeddingRegistry,
} from './embedding/registry';
import { VectorStore } from './embedding/vector-store';
import { Executor } from './executor/executor';
import {
  fallbackToolPluginRegistry,
  loadToolPluginRegistry,
} from './plugin/registry';
import { JobQueue } from './queue/queue';
import { log } from './shared/logger';
import { loadConfig, saveConfig } from './store/config';
import { InteractionStore } from './store/interactions';
import { MemoryStore } from './store/memory';
import type { AppDeps } from './types/deps';
import type { CompiledWorkflow } from './workflow/types';
import { buildTransitionMeta } from './workflow/paths';
import { createWorkflowMachine } from './workflow/presets';
import { WorkflowStore } from './workflow/store';
import { validateWorkflow } from './workflow/validator';

interface BootstrapOptions {
  repoDir: string;
  eventSink?: EventSink;
}

interface BootstrapResult extends AppDeps {
  database: DatabaseConnection;
  config: Config;
  embeddingRegistry: EmbeddingRegistry;
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
  } catch (_) {
    log.warn(
      'failed to load plugin registry from .orca/plugins, using built-ins',
    );
  }

  const interactionStore = new InteractionStore(db, undefined, eventSink);
  const memoryStore = new MemoryStore(db, eventSink);
  const queue = new JobQueue(db, eventSink);

  const config = await loadConfig(db);
  const changes = sanitizeConfig(config, registry);
  validateDefaults(config, registry);
  if (changes.length > 0) {
    for (const change of changes) {
      log.warn('config sanitized', { change });
    }
    await saveConfig(db, eventSink, config);
  }

  // Validate and compile custom workflows from config
  const compiledCustomWorkflows: Record<string, CompiledWorkflow> = {};
  if (config.workflows) {
    for (const [name, workflowConfig] of Object.entries(config.workflows)) {
      const results = validateWorkflow(workflowConfig, config, registry);
      const errors = results.filter((e) => e.severity !== 'warning');
      const warnings = results.filter((e) => e.severity === 'warning');
      if (errors.length > 0) {
        const msgs = errors.map((e) => e.message).join('; ');
        throw new Error(`invalid workflow "${name}": ${msgs}`);
      }
      if (warnings.length > 0) {
        for (const w of warnings) {
          log.warn(
            `workflow "${name}"${w.step ? ` step "${w.step}"` : ''}: ${w.message}`,
          );
        }
      }
      const machine = createWorkflowMachine(workflowConfig.id, workflowConfig);
      compiledCustomWorkflows[name] = {
        machine,
        name,
        transitionMeta: buildTransitionMeta(machine),
      };
    }
  }
  const workflowStore = new WorkflowStore(compiledCustomWorkflows);

  // Initialize embedding registry and provider (non-blocking, graceful fallback)
  const embeddingRegistry = await loadEmbeddingRegistry(repoDir);
  if (config.embeddings?.provider) {
    try {
      const embeddingPlugin = await embeddingRegistry.resolve(
        config.embeddings,
      );
      if (embeddingPlugin) {
        const vectorStore = new VectorStore(database.db, embeddingPlugin);
        memoryStore.setVectorStore(vectorStore);
        queueMicrotask(async () => {
          try {
            await memoryStore.backfillEmbeddings();
          } catch (err) {
            log.warn('embedding backfill failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        });
      }
    } catch (err) {
      log.warn('embedding initialization failed, using FTS fallback', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const executor = new Executor({
    config,
    registry,
    db,
    sink: eventSink,
    interactionStore,
    memoryStore,
    repoDir,
    logsDir: `${repoDir}/.orca/logs`,
    queue,
  });

  return {
    database,
    db,
    sink: eventSink,
    config,
    registry,
    embeddingRegistry,
    interactionStore,
    memoryStore,
    queue,
    executor,
    workflowStore,
    repoDir,
  };
}
