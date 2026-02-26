import * as Collapsible from '@radix-ui/react-collapsible'
import { useCallback, useEffect, useState } from 'react'
import { ActionButton } from '../../common/ActionButton'
import { ToolModelSelector } from '../../common/ToolModelSelector'
import { useTaskDetailContext } from '../../../context/TaskDetailContext'
import { useWSSubscribe } from '../../../lib/wsEvents'
import { controlClass } from '../../../lib/constants'
import { useModelsQuery } from '../../../hooks/queries/useModels'
import { useMergeTaskMutation } from '../../../hooks/queries/useTaskMutations'
import { selectByPhase, useInteractionsQuery } from './useInteractions'
import { InteractionEntry } from './InteractionEntry'

interface Props {
  readOnly?: boolean
}

export function TaskMergeStatus({ readOnly = false }: Props) {
  const {
    task,
    tools,
    activeLogId,
    setActiveLogId,
    isOperationRunning,
    onSaved,
  } = useTaskDetailContext()
  const mergeTaskMutation = useMergeTaskMutation()
  const mergeInteractionsQuery = useInteractionsQuery(task.id, {
    select: selectByPhase('merge'),
  })

  const [mergeTool, setMergeTool] = useState('')
  const [mergeModel, setMergeModel] = useState('')
  const [mergeProgress, setMergeProgress] = useState<string | null>(null)
  const [conflictError, setConflictError] = useState<string | null>(null)
  const [conflictWorktreePath, setConflictWorktreePath] = useState('')
  const [showManualResolve, setShowManualResolve] = useState(false)

  const mergeModelsQuery = useModelsQuery(mergeTool || undefined)
  const mergeInteractions = mergeInteractionsQuery.data ?? []
  const merging =
    isOperationRunning('merge', task.id) || mergeTaskMutation.isPending
  const mergeModels = mergeTool
    ? (mergeModelsQuery.data?.[mergeTool] ?? [])
    : []
  const mergeModelsFetching = mergeModelsQuery.isFetching

  const onMerge = async (mode?: string) => {
    if (!mode) {
      setConflictError(null)
      setConflictWorktreePath('')
      setShowManualResolve(false)
      setMergeProgress('Merge started...')
    } else {
      setMergeProgress('Auto-resolve queued...')
    }
    try {
      await mergeTaskMutation.mutateAsync({
        taskId: task.id,
        mode,
        tool: mergeTool || undefined,
        model: mergeModel || undefined,
      })
    } catch (err: any) {
      setMergeProgress(null)
      alert(err?.message ?? 'Merge failed')
    }
  }
  const onAutoResolve = () => onMerge('auto')
  const onMergeToolChange = (t: string) => {
    setMergeTool(t)
    setMergeModel('')
  }
  const onMergeModelChange = setMergeModel
  const onToggleLog = (id: string) =>
    setActiveLogId(activeLogId === id ? null : id)

  useWSSubscribe(
    useCallback(
      (evt) => {
        const evtTaskId =
          (evt.data as any)?.task_id ?? (evt.data as any)?.id
        if (evtTaskId !== task.id) return

        if (evt.type === 'merge.started') {
          setMergeProgress('Merge started...')
          setConflictError(null)
          setConflictWorktreePath('')
          setShowManualResolve(false)
        } else if (evt.type === 'merge.progress') {
          setMergeProgress(
            String((evt.data as any)?.message ?? 'Resolving...'),
          )
        } else if (evt.type === 'merge.completed') {
          setMergeProgress(null)
          setConflictError(null)
          onSaved()
        } else if (evt.type === 'merge.failed') {
          setMergeProgress(null)
          const isConflict = Boolean((evt.data as any)?.conflict)
          const errMsg = String((evt.data as any)?.error ?? 'Merge failed')
          if (isConflict) {
            setConflictError(errMsg)
            setConflictWorktreePath(
              String((evt.data as any)?.worktree_path ?? ''),
            )
          } else {
            setConflictError(null)
            setConflictWorktreePath('')
            alert(errMsg)
          }
        } else if (evt.type === 'task.updated') {
          const status = String((evt.data as any)?.status ?? '')
          if (status === 'merged' || status === 'approved' || status === 'failed') {
            setMergeProgress(null)
          }
        }
      },
      [task.id, onSaved],
    ),
  )

  useEffect(() => {
    setMergeProgress(null)
    setConflictError(null)
    setConflictWorktreePath('')
    setShowManualResolve(false)
    setMergeTool('')
    setMergeModel('')
  }, [task.id])

  useEffect(() => {
    if (task.status !== 'merged') return
    setMergeProgress(null)
    setConflictError(null)
    setConflictWorktreePath('')
    setShowManualResolve(false)
    setMergeTool('')
    setMergeModel('')
  }, [task.status])

  const latestFailedMergeId =
    mergeInteractions.find((item) => item.status === 'failed')?.id ?? null
  const latestRunningMergeId =
    mergeInteractions.find((item) => item.status === 'running')?.id ?? null

  return (
    <div className="flex flex-col gap-2.5">
      {readOnly &&
        !mergeProgress &&
        !conflictError &&
        mergeInteractions.length === 0 && (
          <div className="text-xs">
            Merge details are read-only for completed tasks.
          </div>
        )}

      {!readOnly && (
        <div className="flex justify-end">
          <ActionButton
            variant="primary"
            onClick={() => void onMerge()}
            disabled={merging}
          >
            {merging ? 'Merging…' : conflictError ? 'Retry Merge' : 'Merge'}
          </ActionButton>
        </div>
      )}

      {mergeInteractions.length === 0 && !mergeProgress && !conflictError && (
        <div className="text-xs">No merge interactions yet.</div>
      )}

      {mergeInteractions.map((item) => (
        <InteractionEntry
          key={item.id}
          interaction={item}
          activeLogId={activeLogId}
          onToggleLog={onToggleLog}
        >
          {item.id === latestRunningMergeId &&
            item.status === 'running' &&
            mergeProgress && (
              <div className="rounded-md border border-[#e0b4b4] bg-[#fff5f5] p-2 text-xs leading-5 text-[#8a1f1f]">
                {mergeProgress}
              </div>
            )}

          {item.id === latestFailedMergeId &&
            item.status === 'failed' &&
            conflictError && (
              <div className="flex flex-col gap-2 rounded-md border border-[#e0b4b4] bg-[#fff5f5] p-3">
                <div className="text-xs leading-5 text-[#8a1f1f]">
                  Merge conflict: {conflictError}
                </div>
                {!readOnly && (
                  <div className="flex flex-col gap-2">
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
                      <ToolModelSelector
                        tools={tools}
                        selectedTool={mergeTool}
                        selectedModel={mergeModel}
                        models={mergeModels}
                        modelsFetching={mergeModelsFetching}
                        onToolChange={onMergeToolChange}
                        onModelChange={onMergeModelChange}
                        controlClass={controlClass}
                        toolPlaceholder="- resolve tool"
                        modelPlaceholder="- default model"
                        className="contents"
                      />
                      <ActionButton
                        variant="primary"
                        onClick={() => void onAutoResolve()}
                        disabled={merging}
                      >
                        Auto-resolve
                      </ActionButton>
                    </div>
                    <Collapsible.Root
                      open={showManualResolve}
                      onOpenChange={setShowManualResolve}
                    >
                      <Collapsible.Trigger asChild>
                        <ActionButton variant="default">
                          Manual resolve
                        </ActionButton>
                      </Collapsible.Trigger>
                      <Collapsible.Content>
                        <div className="mt-2 flex flex-col gap-1.5 text-xs">
                          {conflictWorktreePath && (
                            <div className="font-mono text-[11px]">
                              Worktree: <code>{conflictWorktreePath}</code>
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
        </InteractionEntry>
      ))}

      {mergeProgress && !latestRunningMergeId && (
        <div className="rounded-md border border-[#e0b4b4] bg-[#fff5f5] p-3 text-xs leading-5 text-[#8a1f1f]">
          {mergeProgress}
        </div>
      )}

      {conflictError && !latestFailedMergeId && (
        <div className="rounded-md border border-[#e0b4b4] bg-[#fff5f5] p-3 text-xs leading-5 text-[#8a1f1f]">
          Merge conflict: {conflictError}
        </div>
      )}
    </div>
  )
}
