import { INTERACTION_STATUSES, TASK_STATUSES } from '@orca/server/types';
import { useMemo } from 'react';
import { useInteractionMetaQuery } from '../hooks/useInteractions';
import type { useMergeHandler } from '../hooks/useMergeHandler';
import { useTaskActions } from '../hooks/useTaskActions';
import type { InteractionStub, Task } from '../types';
import { InteractionEntry } from './InteractionEntry';
import { StepContentCard } from './StepContentCard';

type Props = {
  stubs: InteractionStub[];
  task: Task;
  tools: string[];
  readOnly: boolean;
  merge: ReturnType<typeof useMergeHandler>;
};

function InteractionContent({
  taskId,
  stub,
  task,
  tools,
  readOnly,
  merge,
  isLatestRunningMerge,
  isLatestFailedMerge,
}: {
  taskId: string;
  stub: InteractionStub;
  task: Task;
  tools: string[];
  readOnly: boolean;
  merge: ReturnType<typeof useMergeHandler>;
  isLatestRunningMerge: boolean;
  isLatestFailedMerge: boolean;
}) {
  const actions = useTaskActions();
  const metaQuery = useInteractionMetaQuery(taskId, stub.id, true);

  if (metaQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-muted">
        <span className="inline-block h-3 w-16 animate-pulse rounded bg-surface" />
        Loading details...
      </div>
    );
  }

  const interaction = metaQuery.data;
  if (!interaction) return null;

  return (
    <StepContentCard
      interaction={interaction}
      task={task}
      tools={tools}
      readOnly={readOnly}
      merge={merge}
      isLatestRunningMerge={isLatestRunningMerge}
      isLatestFailedMerge={isLatestFailedMerge}
      actions={actions}
    />
  );
}

export function TaskInteractionItems({
  stubs,
  task,
  tools,
  readOnly,
  merge,
}: Props) {
  const actions = useTaskActions();
  const mergeStubs = useMemo(
    () => stubs.filter((item) => item.type === 'merge'),
    [stubs],
  );

  const latestFailedMergeId =
    [...mergeStubs]
      .reverse()
      .find((item) => item.status === INTERACTION_STATUSES.failed)?.id ?? null;
  const latestRunningMergeId =
    [...mergeStubs]
      .reverse()
      .find((item) => item.status === INTERACTION_STATUSES.running)?.id ?? null;

  const hasRunningInteraction = stubs.some(
    (item) => item.status === INTERACTION_STATUSES.running,
  );

  const taskId = task.id;

  // Group consecutive stubs that share a dotted parent (e.g. "implement.code" → "implement")
  type Group = { parent: string | null; items: InteractionStub[] };
  const groups = useMemo(() => {
    const result: Group[] = [];
    for (const item of stubs) {
      const dot = (item.stepName ?? '').indexOf('.');
      const parent = dot > 0 ? item.stepName!.slice(0, dot) : null;
      const last = result[result.length - 1];
      if (last && last.parent === parent) {
        last.items.push(item);
      } else {
        result.push({ parent, items: [item] });
      }
    }
    return result;
  }, [stubs]);

  const renderEntry = (item: InteractionStub) => (
    <InteractionEntry
      key={item.id}
      taskId={taskId}
      stub={item}
      type={item.type}
      name={item.stepName ?? item.type}
      collapsible
      showDiffSummary={item.type === 'code'}
      canReset={
        task.status !== TASK_STATUSES.running &&
        !hasRunningInteraction &&
        item.status === INTERACTION_STATUSES.completed
      }
      onReset={(id) => actions.handleReset(id)}
      onResetAndRun={(id) => actions.handleResetAndRun(id)}
    >
      <InteractionContent
        taskId={taskId}
        stub={item}
        task={task}
        tools={tools}
        readOnly={readOnly}
        merge={merge}
        isLatestRunningMerge={item.id === latestRunningMergeId}
        isLatestFailedMerge={item.id === latestFailedMergeId}
      />
    </InteractionEntry>
  );

  return (
    <div className="flex flex-col gap-2">
      {groups.map((group, gi) =>
        group.parent ? (
          <div
            key={`${group.parent}-${gi}`}
            className="relative flex flex-col gap-2 border-l-2 border-accent/25 pl-3"
          >
            <span className="absolute -left-px -top-1 bg-background px-1 text-[10px] font-medium uppercase tracking-wider text-muted">
              {group.parent}
            </span>
            {group.items.map(renderEntry)}
          </div>
        ) : (
          group.items.map(renderEntry)
        ),
      )}
    </div>
  );
}
