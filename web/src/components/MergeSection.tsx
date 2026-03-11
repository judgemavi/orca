import { INTERACTION_STATUSES } from '@orca/server/types';
import * as Collapsible from '@radix-ui/react-collapsible';
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { useMergeHandler } from '../hooks/useMergeHandler';
import { controlClass } from '../lib/constants';
import type { Interaction, Task } from '../types';
import { Button } from './Button';
import { DiffViewer } from './DiffViewer';
import { ToolModelSelector } from './ToolModelSelector';

type MergeState = ReturnType<typeof useMergeHandler>;

type Props = {
  interaction: Interaction;
  task: Task;
  readOnly: boolean;
  tools: string[];
  isLatestRunning: boolean;
  isLatestFailed: boolean;
  merge: MergeState;
};

function MergeDiff({
  interaction,
  task,
}: {
  interaction: Interaction;
  task: Task;
}) {
  const [diff, setDiff] = useState<string | null>(null);
  const [filesChanged, setFilesChanged] = useState<string[]>([]);

  useEffect(() => {
    if (interaction.status !== INTERACTION_STATUSES.completed) return;
    if (!interaction.commitSha) return;
    let cancelled = false;
    api.getInteractionDiff(task.id, interaction.id).then((res) => {
      if (!cancelled) {
        setDiff(res.diff || null);
        setFilesChanged(res.filesChanged);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [interaction.id, interaction.status, interaction.commitSha, task.id]);

  if (!diff) return null;

  return (
    <DiffViewer
      data={{
        taskId: task.id,
        title: `Merged: ${task.title}`,
        diff,
        filesChanged,
        actions: [],
      }}
    />
  );
}

export function MergeSection({
  interaction,
  task,
  readOnly,
  tools,
  isLatestRunning,
  isLatestFailed,
  merge,
}: Props) {
  if (interaction.type !== 'merge') return null;

  return (
    <>
      <MergeDiff interaction={interaction} task={task} />

      {isLatestRunning &&
        interaction.status === INTERACTION_STATUSES.running &&
        merge.mergeProgress && (
          <div className="rounded-lg bg-accent/10 p-4 text-xs leading-5 text-accent">
            {merge.mergeProgress}
          </div>
        )}

      {isLatestFailed &&
        interaction.status === INTERACTION_STATUSES.failed &&
        merge.conflictError && (
          <div className="flex flex-col gap-2 rounded-lg bg-danger/10 p-4 text-danger">
            <div className="text-xs leading-5">
              Merge conflict: {merge.conflictError}
            </div>
            {!readOnly && (
              <div className="flex flex-col gap-2">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
                  <ToolModelSelector
                    tools={tools}
                    selectedTool={merge.mergeTool}
                    selectedModel={merge.mergeModel}
                    models={merge.mergeModels}
                    modelsFetching={merge.mergeModelsFetching}
                    onToolChange={merge.onMergeToolChange}
                    onModelChange={merge.onMergeModelChange}
                    controlClass={controlClass}
                    toolPlaceholder="- resolve tool"
                    modelPlaceholder="- default model"
                    className="contents"
                  />
                  <Button
                    variant="primary"
                    onClick={() => void merge.onAutoResolve()}
                    disabled={merge.merging}
                  >
                    Auto-resolve
                  </Button>
                </div>
                <Collapsible.Root
                  open={merge.showManualResolve}
                  onOpenChange={merge.setShowManualResolve}
                >
                  <Collapsible.Trigger asChild>
                    <Button variant="default">Manual resolve</Button>
                  </Collapsible.Trigger>
                  <Collapsible.Content>
                    <div className="mt-2 flex flex-col gap-2 text-xs">
                      {merge.conflictWorktreePath && (
                        <div className="font-mono text-xs">
                          Worktree: <code>{merge.conflictWorktreePath}</code>
                        </div>
                      )}
                      <div>
                        Resolve conflicts in the worktree, commit the fixes,
                        then click Retry Merge.
                      </div>
                    </div>
                  </Collapsible.Content>
                </Collapsible.Root>
              </div>
            )}
          </div>
        )}
    </>
  );
}
