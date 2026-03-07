import type { EventSink } from '../api/ws';
import type { ToolPluginEvent } from '../plugin/types';
import type { InteractionStore } from '../store/interactions';
import type { MemoryStore } from '../store/memory';
import type { TaskStore } from '../store/tasks';
import type { TaskStatus } from '../types';

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
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  events: ToolPluginEvent[];
  logPath: string;
  durationMS: number;
  timedOut: boolean;
  aborted: boolean;
  diff: string;
  filesChanged: string[];
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
  runID: string;
  model: string;
  result: TaskRunResultRecord;
}

interface PersistSuccessfulTaskResultInput extends PersistTaskResultInput {
  reviewID?: string;
  memoryMeta?: InteractionMemoryMeta;
}

interface ResultCoordinatorDeps {
  taskStore: TaskStore;
  interactionStore?: InteractionStore;
  memoryStore?: MemoryStore;
  eventSink?: EventSink;
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

export class ResultCoordinator {
  constructor(private readonly deps: ResultCoordinatorDeps) {}

  applyStopOverride(
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

  buildFailedResult(input: FailedTaskRunInput): TaskRunResultRecord {
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
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
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

  async persistSuccess(input: PersistSuccessfulTaskResultInput): Promise<void> {
    if (input.result.sessionID.trim()) {
      await this.deps.taskStore.setSessionID(
        input.taskID,
        input.result.sessionID.trim(),
      );
    }

    await this.deps.taskStore.updateStatus(input.taskID, input.result.status);
    this.reinforceMemoryConfidence(input.taskID, input.result.exitCode);

    if (input.reviewID && input.result.status === 'review') {
      await this.deps.taskStore.addressReview(input.reviewID);
    }

    this.finishInteraction(
      input.interactionID,
      input.result,
      input.runID,
      input.model,
      input.memoryMeta,
    );
  }

  async persistFailure(input: PersistTaskResultInput): Promise<void> {
    await this.deps.taskStore.updateStatus(input.taskID, input.result.status);
    this.finishInteraction(
      input.interactionID,
      input.result,
      input.runID,
      input.model,
    );
  }

  private finishInteraction(
    interactionID: string,
    result: TaskRunResultRecord,
    runID: string,
    model: string,
    memoryMeta?: InteractionMemoryMeta,
  ): void {
    if (!interactionID || !this.deps.interactionStore) return;

    let qualityJson: string | null = null;
    if (memoryMeta) {
      const payload: Record<string, unknown> = {};
      if (memoryMeta.usedMemoryIds?.length) {
        payload.usedMemoryIds = memoryMeta.usedMemoryIds;
      }
      if (memoryMeta.usedProvenanceHashes?.length) {
        payload.usedProvenanceHashes = memoryMeta.usedProvenanceHashes;
      }
      if (Object.keys(payload).length > 0) {
        qualityJson = JSON.stringify(payload);
      }
    }

    void this.deps.interactionStore.finish(interactionID, {
      status: result.interactionStatus,
      error: result.error ?? null,
      diff: result.diff || null,
      qualityJson: qualityJson,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      estimatedCost: result.estimatedCost,
      exitCode: result.exitCode,
      durationMs: result.durationMS,
      runId: runID,
      model,
    });
  }

  private reinforceMemoryConfidence(taskID: string, exitCode: number): void {
    if (!this.deps.memoryStore || !this.deps.interactionStore) return;

    void this.loadUsedMemoryIDs(taskID).then(async (ids) => {
      if (ids.length === 0) return;
      for (const id of ids) {
        try {
          if (exitCode === 0) {
            await this.deps.memoryStore!.boostConfidence(id, 1.1);
          } else {
            await this.deps.memoryStore!.decayEntry(id, 0.9);
          }
        } catch {
          // Ignore stale references.
        }
      }
    });
  }

  private async loadUsedMemoryIDs(taskID: string): Promise<string[]> {
    const seen = new Set<string>();
    const planInteractions =
      (await this.deps.interactionStore?.listByType(taskID, 'plan')) ?? [];
    for (const interaction of planInteractions) {
      const payload = interaction.qualityJson?.trim();
      if (!payload) continue;
      try {
        const parsed = JSON.parse(payload) as { usedMemoryIds?: string[] };
        for (const id of parsed.usedMemoryIds ?? []) {
          const normalized = String(id).trim();
          if (normalized) seen.add(normalized);
        }
      } catch {
        // Ignore malformed quality payloads.
      }
    }
    return [...seen];
  }
}
