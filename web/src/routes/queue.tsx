import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge, type BadgeVariant } from '../components/Badge';
import { Button } from '../components/Button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/table';
import {
  useCancelJob,
  useDrainQueue,
  useQueueCounts,
  useQueueQuery,
} from '../hooks/useQueue';
import type { Job, JobStatus } from '../types';

type FilterStatus = JobStatus | 'all';

const FILTERS: { label: string; value: FilterStatus }[] = [
  { label: 'All', value: 'all' },
  { label: 'Queued', value: 'queued' },
  { label: 'Running', value: 'running' },
  { label: 'Completed', value: 'completed' },
  { label: 'Failed', value: 'failed' },
];

const JOB_VARIANT: Record<JobStatus, BadgeVariant> = {
  queued: 'default',
  running: 'blue',
  completed: 'emerald',
  failed: 'rose',
  cancelled: 'default',
};

import { formatRelativeTime } from '../lib/format';

function JobStatusBadge({ status }: { status: JobStatus }) {
  return (
    <Badge variant={JOB_VARIANT[status]}>
      {status === 'running' ? (
        <span className="flex items-center gap-1">
          <span className="inline-block h-1.5 w-1.5 animate-spin rounded-full border border-blue-600 border-t-transparent dark:border-blue-300" />
          running
        </span>
      ) : (
        status
      )}
    </Badge>
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
    <TableRow className="last:border-b-0">
      <TableCell className="text-xs font-mono">{job.type}</TableCell>
      <TableCell className="text-xs">
        {job.taskId ? (
          <Link
            to="/$taskId"
            params={{ taskId: job.taskId }}
            className="font-mono text-accent hover:underline"
          >
            {job.taskId}
          </Link>
        ) : (
          <span className="text-muted">—</span>
        )}
      </TableCell>
      <TableCell>
        <JobStatusBadge status={job.status} />
      </TableCell>
      <TableCell className="text-xs tabular-nums text-muted">
        {job.priority}
      </TableCell>
      <TableCell className="text-xs text-muted">
        {formatRelativeTime(job.createdAt)}
      </TableCell>
      <TableCell className="text-xs text-muted">
        {formatRelativeTime(job.startedAt)}
      </TableCell>
      <TableCell>
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
      </TableCell>
    </TableRow>
  );
}

function QueuePage() {
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
    <div className="flex flex-1 overflow-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-4">
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
              <Table className="min-w-160">
                <TableHeader>
                  <TableRow>
                    {[
                      'Type',
                      'Task',
                      'Status',
                      'Priority',
                      'Created',
                      'Started',
                      '',
                    ].map((h) => (
                      <TableHead key={h} className="h-9 text-xs text-muted">
                        {h}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
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
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/queue')({
  component: QueuePage,
});
