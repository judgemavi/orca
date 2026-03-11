import type { TaskStatus } from '@orca/types';
import type { EventSink } from '../api/ws';
import type { OrcaDrizzleDB } from '../db/connection';
import type { ToolPluginEvent } from '../plugin/types';
import type { InteractionStore } from '../store/interactions';
import type { MemoryStore } from '../store/memory';
import * as taskStore from '../store/tasks';

interface OutcomeInput {
  exitCode: number;
  timedOut: boolean;
  aborted: boolean;
  diff: string;
  outputTail: string;
  workerError?: string;
}

interface OutcomeResult {
  taskStatus: TaskStatus;
  interactionStatus: 'completed' | 'failed';
  error?: string;
}

interface TaskRunResultRecord {
  taskID: string;
  interactionType: string;
  toolName: string;
  model: string;
  status: TaskStatus;
  interactionStatus: 'completed' | 'failed';
  exitCode: number;
  signalCode: string | number | null;
  sessionID: string;
  events: ToolPluginEvent[];
  logPath: string;
  durationMS: number;
  timedOut: boolean;
  aborted: boolean;
  diff: string;
  filesChanged: string[];
  commitSha?: string;
  error?: string;
}

interface FailedTaskRunInput {
  taskID: string;
  interactionType: string;
  toolName: string;
  model: string;
  status: TaskStatus;
  aborted: boolean;
  error: string;
  logPath: string;
}

interface InteractionMemoryMeta {
  usedMemoryIds: string[];
  usedProvenanceHashes: string[];
}

interface PersistTaskResultInput {
  taskID: string;
  interactionID: string;
  model: string;
  result: TaskRunResultRecord;
}

interface PersistSuccessfulTaskResultInput extends PersistTaskResultInput {
  memoryMeta?: InteractionMemoryMeta;
}

export interface ResultCoordinatorDeps {
  db: OrcaDrizzleDB;
  sink?: EventSink;
  interactionStore?: InteractionStore;
  memoryStore?: MemoryStore;
}

const BLOCKER_PATTERN =
  /(?:BLOCKED:|cannot complete|permission denied|operation not permitted|unable to write|read-only file system|no such file or directory|sandbox.{0,20}(?:block|prevent|restrict))/i;

export function evaluateTaskOutcome(input: OutcomeInput): OutcomeResult {
  if (input.aborted) {
    return {
      taskStatus: 'stopped',
      interactionStatus: 'failed',
      error: input.workerError || 'task stopped',
    };
  }

  if (input.timedOut) {
    return {
      taskStatus: 'failed',
      interactionStatus: 'failed',
      error: input.workerError || 'task timed out',
    };
  }

  if (input.exitCode !== 0) {
    return {
      taskStatus: 'failed',
      interactionStatus: 'failed',
      error: input.workerError || `process exited with code ${input.exitCode}`,
    };
  }

  const diff = input.diff.trim();
  if (diff) {
    return { taskStatus: 'review', interactionStatus: 'completed' };
  }

  const blocker = detectBlocker(input.outputTail);
  if (blocker) {
    return {
      taskStatus: 'failed',
      interactionStatus: 'failed',
      error: `no changes produced; blocker detected: ${blocker}`,
    };
  }

  return {
    taskStatus: 'failed',
    interactionStatus: 'failed',
    error: 'no changes produced',
  };
}

function detectBlocker(output: string): string {
  const tail = output.length > 2_000 ? output.slice(-2_000) : output;
  const match = tail.match(BLOCKER_PATTERN);
  return match?.[0]?.trim() ?? '';
}

export function applyStopOverride(
  taskID: string,
  result: TaskRunResultRecord,
  consumeStop: (taskID: string) => boolean,
): TaskRunResultRecord {
  if (!consumeStop(taskID)) {
    return result;
  }

  return {
    ...result,
    status: 'stopped',
    interactionStatus: 'failed',
    aborted: true,
    error: result.error || 'task stopped',
  };
}

export function buildFailedResult(
  input: FailedTaskRunInput,
): TaskRunResultRecord {
  return {
    taskID: input.taskID,
    interactionType: input.interactionType,
    toolName: input.toolName,
    model: input.model,
    status: input.status,
    interactionStatus: 'failed',
    exitCode: -1,
    signalCode: null,
    sessionID: '',
    events: [],
    logPath: input.logPath,
    durationMS: 0,
    timedOut: false,
    aborted: input.aborted,
    diff: '',
    filesChanged: [],
    error: input.error,
  };
}

export async function persistSuccess(
  deps: ResultCoordinatorDeps,
  input: PersistSuccessfulTaskResultInput,
): Promise<void> {
  await persistResultStatus(deps, input.taskID, input.result.status);
  reinforceMemoryConfidence(deps, input.taskID, input.result.exitCode);

  finishInteraction(
    deps,
    input.interactionID,
    input.result,
    input.model,
    input.memoryMeta,
  );
}

export async function persistFailure(
  deps: ResultCoordinatorDeps,
  input: PersistTaskResultInput,
): Promise<void> {
  await persistResultStatus(deps, input.taskID, input.result.status);
  finishInteraction(deps, input.interactionID, input.result, input.model);
}

async function persistResultStatus(
  deps: ResultCoordinatorDeps,
  taskID: string,
  resultStatus: TaskStatus,
): Promise<void> {
  if (resultStatus === 'stopped' || resultStatus === 'failed') {
    await taskStore.updateTask(deps.db, deps.sink, taskID, {
      status: resultStatus,
    });
  } else if (resultStatus === 'review') {
    await taskStore.updateTask(deps.db, deps.sink, taskID, {
      status: 'review',
    });
  }
  // For other statuses (merged, planned), let the workflow engine handle it
  // via completeStepActor after the machine transitions.
}

function finishInteraction(
  deps: ResultCoordinatorDeps,
  interactionID: string,
  result: TaskRunResultRecord,
  model: string,
  memoryMeta?: InteractionMemoryMeta,
): void {
  if (!interactionID || !deps.interactionStore) return;

  const data: Record<string, unknown> = {};
  if (result.filesChanged?.length) data.filesChanged = result.filesChanged;
  if (memoryMeta?.usedMemoryIds?.length)
    data.usedMemoryIds = memoryMeta.usedMemoryIds;
  if (memoryMeta?.usedProvenanceHashes?.length)
    data.usedProvenanceHashes = memoryMeta.usedProvenanceHashes;

  const outputJson =
    Object.keys(data).length > 0
      ? JSON.stringify({
          result: result.interactionStatus === 'completed' ? 'success' : 'fail',
          data,
        })
      : null;

  void deps.interactionStore.finish(interactionID, {
    status: result.interactionStatus,
    error: result.error ?? null,
    output: outputJson,
    exitCode: result.exitCode,
    durationMs: result.durationMS,
    model,
    commitSha: result.commitSha ?? null,
    sessionId: result.sessionID ?? null,
  });
}

function reinforceMemoryConfidence(
  deps: ResultCoordinatorDeps,
  taskID: string,
  exitCode: number,
): void {
  if (!deps.memoryStore || !deps.interactionStore) return;

  void loadUsedMemoryIDs(deps, taskID).then(async (ids) => {
    if (ids.length === 0) return;
    for (const id of ids) {
      try {
        if (exitCode === 0) {
          await deps.memoryStore!.boostConfidence(id, 1.1);
        } else {
          await deps.memoryStore!.decayEntry(id, 0.9);
        }
      } catch {
        // Ignore stale references.
      }
    }
  });
}

async function loadUsedMemoryIDs(
  deps: ResultCoordinatorDeps,
  taskID: string,
): Promise<string[]> {
  const seen = new Set<string>();
  // Query all interactions for the task and filter for context-type steps
  // that may contain usedMemoryIds in their output
  const allInteractions = (await deps.interactionStore?.list(taskID)) ?? [];
  const planInteractions = allInteractions.filter(
    (ix) => ix.type === 'plan' || ix.type === 'context',
  );
  for (const interaction of planInteractions) {
    if (!interaction.output?.trim()) continue;
    try {
      const parsed = JSON.parse(interaction.output) as {
        result?: string;
        data?: { usedMemoryIds?: string[] };
      };
      for (const id of parsed.data?.usedMemoryIds ?? []) {
        const normalized = String(id).trim();
        if (normalized) seen.add(normalized);
      }
    } catch {
      // Ignore malformed output payloads.
    }
  }
  return [...seen];
}
