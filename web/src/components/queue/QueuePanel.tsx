import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  useCancelJob,
  useDrainQueue,
  useQueueCounts,
  useQueueQuery,
} from '../../hooks/useQueue';
import type { Job, JobStatus } from '../../types';
import { Button } from '../Button';

type FilterStatus = JobStatus | 'all';

const FILTERS: { label: string; value: FilterStatus }[] = [
  { label: 'All', value: 'all' },
  { label: 'Queued', value: 'queued' },
  { label: 'Running', value: 'running' },
  { label: 'Completed', value: 'completed' },
  { label: 'Failed', value: 'failed' },
];

const STATUS_BADGE: Record<JobStatus, string> = {
  queued: 'bg-surface-alt text-muted',
  running: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  completed: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  failed: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  cancelled: 'bg-surface-alt text-muted',
};

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const diffMs = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diffMs)) return '—';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}

function StatusBadge({ status }: { status: JobStatus }) {
  return (
    <span
      className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[status]}`}
    >
      {status === 'running' ? (
        <span className="flex items-center gap-1">
          <span className="inline-block h-1.5 w-1.5 animate-spin rounded-full border border-blue-600 border-t-transparent dark:border-blue-300" />
          running
        </span>
      ) : (
        status
      )}
    </span>
  );
}

function JobRow({
  job,
  onCancel,
  cancelling,
}: {
  job: Job;
  onCancel: (id: string) => void;
  cancelling: boolean;
}) {
  return (
    <tr className="border-b transition-colors hover:bg-muted/10 last:border-b-0">
      <td className="p-2 text-xs font-mono">{job.type}</td>
      <td className="p-2 text-xs">
        {job.taskId ? (
          <Link
            to="/$taskId"
            params={{ taskId: job.taskId }}
            className="font-mono text-accent hover:underline"
          >
            {job.taskId.slice(0, 8)}
          </Link>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
      <td className="p-2">
        <StatusBadge status={job.status} />
      </td>
      <td className="p-2 text-xs tabular-nums text-muted">{job.priority}</td>
      <td className="p-2 text-xs text-muted whitespace-nowrap">
        {relativeTime(job.createdAt)}
      </td>
      <td className="p-2 text-xs text-muted whitespace-nowrap">
        {relativeTime(job.startedAt)}
      </td>
      <td className="p-2">
        {job.status === 'queued' ? (
          <Button
            className="px-2 py-0.5 text-xs"
            variant="destructive"
            disabled={cancelling}
            onClick={() => onCancel(job.id)}
          >
            Cancel
          </Button>
        ) : null}
      </td>
    </tr>
  );
}

export function QueuePanel() {
  const [filter, setFilter] = useState<FilterStatus>('all');
  const { data: jobs = [], isLoading } = useQueueQuery(
    filter === 'all' ? undefined : { status: filter },
  );
  const { data: counts } = useQueueCounts();
  const cancelMutation = useCancelJob();
  const drainMutation = useDrainQueue();

  const handleCancel = (jobId: string) => {
    cancelMutation.mutate(jobId, {
      onSuccess: () => toast.success('Job cancelled'),
      onError: (err) =>
        toast.error(err instanceof Error ? err.message : 'Cancel failed'),
    });
  };

  const handleDrain = () => {
    drainMutation.mutate(undefined, {
      onSuccess: (result) =>
        toast.success(`Drained ${result.cancelled} queued jobs`),
      onError: (err) =>
        toast.error(err instanceof Error ? err.message : 'Drain failed'),
    });
  };

  const queued = counts?.queued ?? 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col py-4">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3">
        <h1 className="text-lg font-semibold">Queue</h1>
        <div className="flex items-center gap-2">
          {counts ? (
            <span className="text-xs text-muted">
              {counts.running ?? 0} running, {counts.queued ?? 0} queued
            </span>
          ) : null}
          <Button
            variant="destructive"
            onClick={handleDrain}
            disabled={drainMutation.isPending || queued === 0}
          >
            {drainMutation.isPending ? 'Draining…' : 'Drain All'}
          </Button>
        </div>
      </div>

      <div className="mb-3 flex gap-1">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setFilter(f.value)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              filter === f.value
                ? 'bg-accent text-white'
                : 'border border-border-subtle hover:bg-surface-alt'
            }`}
          >
            {f.label}
            {f.value !== 'all' && counts?.[f.value] != null ? (
              <span className="ml-1.5 text-[10px] opacity-70">
                {counts[f.value]}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-accent" />
        </div>
      ) : jobs.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <p className="text-sm text-muted">
            No jobs{filter !== 'all' ? ` with status "${filter}"` : ''}.
          </p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border-subtle">
          <table className="w-full min-w-[640px]">
            <thead>
              <tr className="border-b">
                {[
                  'Type',
                  'Task',
                  'Status',
                  'Priority',
                  'Created',
                  'Started',
                  '',
                ].map((h) => (
                  <th
                    key={h}
                    className="h-9 px-2 text-left align-middle text-xs font-medium whitespace-nowrap text-muted"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  onCancel={handleCancel}
                  cancelling={
                    cancelMutation.isPending &&
                    cancelMutation.variables === job.id
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
