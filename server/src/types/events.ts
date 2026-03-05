import type {
  AIReviewResult,
  Config,
  ProposedTask,
  TaskEvaluation,
} from './api';
import type { Interaction, Task } from './models';

interface WSEventBase<TType extends string, TData> {
  type: TType;
  timestamp: string;
  data: TData;
}

export interface SessionEventData {
  id: string;
  type: string;
  tool: string;
  taskId: string;
  exitCode: number;
  status?: string;
}

export interface MergeFailedEventData {
  taskId?: string;
  error: string;
  conflict?: boolean;
  worktreePath?: string;
}

export interface MergeProgressEventData {
  taskId: string;
  message?: string;
  status?: string;
  error?: string;
}

export type KnownWSEvent =
  | WSEventBase<'task.created', Task>
  | WSEventBase<'task.updated', Task | { id: string }>
  | WSEventBase<'task.deleted', { id: string }>
  | WSEventBase<'config.updated', Config>
  | WSEventBase<'plan.generating', { taskId: string }>
  | WSEventBase<'plan.failed', { taskId: string; error: string }>
  | WSEventBase<'plan.completed', { taskId: string; plan: string }>
  | WSEventBase<'evaluate.started', { taskId: string }>
  | WSEventBase<
      'evaluate.completed',
      { taskId: string; evaluation: TaskEvaluation }
    >
  | WSEventBase<'evaluate.failed', { taskId: string; error: string }>
  | WSEventBase<'merge.started', { taskId?: string; mode?: string }>
  | WSEventBase<'merge.progress', MergeProgressEventData>
  | WSEventBase<'merge.failed', MergeFailedEventData>
  | WSEventBase<
      'merge.completed',
      Task | { merged: string[]; failed: string[] }
    >
  | WSEventBase<'interaction.started', Interaction | { id: string }>
  | WSEventBase<'interaction.updated', Interaction | { id: string }>
  | WSEventBase<'interaction.completed', Interaction | { id: string }>
  | WSEventBase<'interaction.failed', Interaction | { id: string }>
  | WSEventBase<'session.created', SessionEventData>
  | WSEventBase<'session.exited', SessionEventData>
  | WSEventBase<
      'worker.output',
      { taskId: string; stream: string; line: string; ts: string }
    >
  | WSEventBase<'worker.done', { taskId: string; exitCode: number }>
  | WSEventBase<'worker.output.end', { taskId: string; ts: string }>
  | WSEventBase<'run.failed', { error: string; taskIds?: string[] }>
  | WSEventBase<'run.completed', { results?: unknown; taskIds: string[] }>
  | WSEventBase<'cleanup.started', Record<string, never>>
  | WSEventBase<'cleanup.progress', { removed: string }>
  | WSEventBase<'cleanup.completed', { removed: number }>
  | WSEventBase<'explore.failed', { error: string }>
  | WSEventBase<'explore.completed', { path: string }>
  | WSEventBase<'ai_review.failed', { taskId: string; error: string }>
  | WSEventBase<'ai_review.completed', AIReviewResult>
  | WSEventBase<
      'breakdown.started',
      { taskId: string; sessionId?: string; operationId?: string }
    >
  | WSEventBase<
      'breakdown.failed',
      {
        taskId: string;
        error: string;
        sessionId?: string;
        operationId?: string;
      }
    >
  | WSEventBase<
      'breakdown.completed',
      {
        taskId: string;
        proposed: ProposedTask[];
        interactionId?: string;
        sessionId?: string;
        operationId?: string;
      }
    >
  | WSEventBase<
      'breakdown.rejected',
      { taskId: string; interactionId: string; rejected: boolean }
    >
  | WSEventBase<
      'monitor.alert',
      { type: string; taskId: string; message: string; timestamp: string }
    >
  | WSEventBase<'monitor.conflict', { taskIds: string[]; files: string[] }>
  | WSEventBase<'monitor.stuck', { taskId: string; message: string }>
  | WSEventBase<'quality.alert', { taskId: string; issues: string[] }>
  | WSEventBase<
      'queue.job.queued',
      { jobId: string; type: string; taskId?: string; priority: number }
    >
  | WSEventBase<
      'queue.job.started',
      { jobId: string; type: string; taskId?: string }
    >
  | WSEventBase<
      'queue.job.completed',
      { jobId: string; type: string; taskId?: string }
    >
  | WSEventBase<
      'queue.job.failed',
      { jobId: string; type: string; taskId?: string; error: string }
    >
  | WSEventBase<
      'queue.job.cancelled',
      { jobId: string; type: string; taskId?: string }
    >;

type KnownWSEventType = KnownWSEvent['type'];

export type UnknownWSEvent = WSEventBase<string, Record<string, unknown>>;

export type WSEvent = KnownWSEvent | UnknownWSEvent;

const KNOWN_WS_EVENT_TYPES = new Set<KnownWSEventType>([
  'task.created',
  'task.updated',
  'task.deleted',
  'config.updated',
  'plan.generating',
  'plan.failed',
  'plan.completed',
  'evaluate.started',
  'evaluate.completed',
  'evaluate.failed',
  'merge.started',
  'merge.progress',
  'merge.failed',
  'merge.completed',
  'interaction.started',
  'interaction.updated',
  'interaction.completed',
  'interaction.failed',
  'session.created',
  'session.exited',
  'worker.output',
  'worker.done',
  'worker.output.end',
  'run.failed',
  'run.completed',
  'cleanup.started',
  'cleanup.progress',
  'cleanup.completed',
  'explore.failed',
  'explore.completed',
  'ai_review.failed',
  'ai_review.completed',
  'breakdown.started',
  'breakdown.failed',
  'breakdown.completed',
  'breakdown.rejected',
  'monitor.alert',
  'queue.job.queued',
  'queue.job.started',
  'queue.job.completed',
  'queue.job.failed',
  'queue.job.cancelled',
]);

function isKnownWSEventType(type: string): type is KnownWSEventType {
  return KNOWN_WS_EVENT_TYPES.has(type as KnownWSEventType);
}

export function isKnownWSEvent(event: WSEvent): event is KnownWSEvent {
  return isKnownWSEventType(event.type);
}
