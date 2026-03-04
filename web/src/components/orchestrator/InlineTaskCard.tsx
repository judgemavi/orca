import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api } from '../../api';
import { queryKeys } from '../../lib/queryKeys';
import { StatusBadge } from '../common/StatusBadge';

interface Props {
  taskId: string;
  task?: {
    id?: string;
    title?: string;
    status?: string;
  } | null;
  className?: string;
}

const TASK_ID_RE = /^[a-f0-9]{8,64}$/i;

export function InlineTaskCard({ taskId, task, className }: Props) {
  const trimmedID = taskId.trim();
  const hasTaskID = TASK_ID_RE.test(trimmedID);
  const shouldFetch = !task?.title && hasTaskID;

  const taskQuery = useQuery({
    queryKey: queryKeys.task(trimmedID),
    queryFn: () => api.getTask(trimmedID),
    enabled: shouldFetch,
    retry: false,
  });

  const title = task?.title?.trim() || taskQuery.data?.title?.trim();
  const status = task?.status?.trim() || taskQuery.data?.status?.trim();
  const resolvedID =
    task?.id?.trim() || taskQuery.data?.id?.trim() || trimmedID;
  const shortID = resolvedID.slice(0, 8);
  const isGone = shouldFetch && taskQuery.isError;

  if (!hasTaskID) {
    return (
      <span
        className={`inline-flex items-center rounded border border-border-subtle bg-surface-alt/40 px-2 py-0.5 font-mono text-[11px] ${className ?? ''}`}
      >
        {taskId}
      </span>
    );
  }

  if (taskQuery.isLoading && !title) {
    return (
      <span
        className={`inline-flex items-center rounded border border-border-subtle bg-surface-alt/40 px-2 py-0.5 text-[11px] text-muted ${className ?? ''}`}
      >
        Loading task {shortID}...
      </span>
    );
  }

  if (isGone) {
    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-surface-alt/30 px-1.5 py-1 text-[11px] opacity-60 ${className ?? ''}`}
      >
        <span className="rounded bg-danger/15 px-1 py-0.5 text-[10px] font-medium text-danger">
          deleted
        </span>
        <span className="font-mono text-muted">{shortID}</span>
      </span>
    );
  }

  if (!title || !status) {
    return (
      <span
        className={`inline-flex items-center rounded border border-border-subtle bg-surface-alt/40 px-2 py-0.5 font-mono text-[11px] ${className ?? ''}`}
      >
        {shortID}
      </span>
    );
  }

  return (
    <Link
      to="/$taskId"
      params={{ taskId: resolvedID }}
      className={`inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-surface px-1.5 py-1 text-[11px] transition-colors hover:border-accent/50 hover:bg-surface-alt ${className ?? ''}`}
    >
      <StatusBadge status={status} />
      <span className="max-w-52 truncate font-medium text-foreground">
        {title}
      </span>
      <span className="font-mono text-muted">{shortID}</span>
    </Link>
  );
}
