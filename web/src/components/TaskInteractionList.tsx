import * as Accordion from '@radix-ui/react-accordion';
import { useMemo } from 'react';
import { useTaskDetailContext } from '../context/TaskDetailContext';
import { useInteractionsQuery } from '../hooks/useInteractions';
import { useMergeHandler } from '../hooks/useMergeHandler';
import type { InteractionStub } from '../types';
import { TaskInteractionItems } from './TaskInteractionItems';

interface Props {
  taskId: string;
  readOnly?: boolean;
}

export function TaskInteractionList({ taskId, readOnly = false }: Props) {
  const { task, tools, isOperationRunning } = useTaskDetailContext();

  const { data: interactions, isLoading } = useInteractionsQuery(taskId);

  const merge = useMergeHandler({
    taskId,
    taskStatus: task.status,
    isOperationRunning,
  });

  const interactionStubs = useMemo<InteractionStub[]>(
    () =>
      (interactions ?? []).map((interaction) => {
        const stub = interaction as InteractionStub;
        return {
          ...stub,
          stepName: stub.stepName ?? undefined,
          memoryCount: stub.memoryCount ?? undefined,
          previousInteractionId: stub.previousInteractionId ?? undefined,
          commitSha: stub.commitSha ?? undefined,
          sessionId: stub.sessionId ?? undefined,
        };
      }),
    [interactions],
  );

  return (
    <Accordion.Root
      type="multiple"
      className="flex flex-col gap-4 rounded-lg bg-surface p-4"
    >
      {isLoading && <div className="text-xs">Loading interactions...</div>}
      {!isLoading && interactions?.length === 0 && (
        <div className="text-xs">No interactions yet.</div>
      )}
      {!isLoading && interactionStubs.length > 0 && (
        <TaskInteractionItems
          stubs={interactionStubs}
          task={task}
          tools={tools}
          readOnly={readOnly}
          merge={merge}
        />
      )}
    </Accordion.Root>
  );
}
