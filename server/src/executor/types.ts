import type { TaskStatus } from '@orca/types';
import type { EventSink } from '../api/ws';
import type { OrcaDrizzleDB } from '../db/connection';
import type { Config } from '../db/schema';
import type { ToolPluginRegistry } from '../plugin/registry';
import type { JobQueue } from '../queue/queue';
import type { InteractionStore } from '../store/interactions';
import type { MemoryStore } from '../store/memory';
import type { WorkflowStore } from '../workflow/store';
import type { Monitor } from './monitor';

export interface ExecutorDeps {
  config: Config;
  registry: ToolPluginRegistry;
  db: OrcaDrizzleDB;
  sink?: EventSink;
  interactionStore?: InteractionStore;
  memoryStore?: MemoryStore;
  workflowStore?: WorkflowStore;
  repoDir: string;
  logsDir: string;
  queue?: JobQueue;
}

export interface RunOptions {
  toolOverride?: string;
  modelOverride?: string;
  context?: string;
}

export interface InternalRunOptions extends RunOptions {
  resumeSessionID?: string;
  feedback?: string;
  monitor?: Monitor;
  interactionType?: string;
  stepName?: string;
  previousInteractionId?: string | null;
}

export interface ResumeContext {
  interactionType: string;
  resumeSessionID: string;
  feedback: string;
}

export interface TaskContextSection {
  context: string;
  usedMemoryIDs: string[];
  usedProvenanceHashes: string[];
}

export interface RuntimeControl {
  consumeStop(taskID: string): boolean;
  registerController(taskID: string, controller: AbortController): void;
  releaseController(taskID: string): void;
}

export const RUNNABLE_STATUSES = new Set<TaskStatus>([
  'pending',
  'planned',
  'failed',
  'review',
]);
