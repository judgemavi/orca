import { ActionButton } from '../../common/ActionButton'
import { ToolModelSelector } from '../../common/ToolModelSelector'
import { useTaskDetailContext } from '../../../context/TaskDetailContext'
import { InteractionEntry } from './InteractionEntry'

interface Props {
  readOnly?: boolean
}

export function TaskMergeStatus({ readOnly = false }: Props) {
  const {
    tools,
    controlClass,
    mergeTool,
    setMergeTool,
    mergeModel,
    setMergeModel,
    mergeModels,
    mergeModelsFetching,
    mergeProgress,
    conflictError,
    merging,
    showManualResolve,
    setShowManualResolve,
    conflictWorktreePath,
    mergeInteractions,
    activeLogId,
    setActiveLogId,
    handleMerge,
  } = useTaskDetailContext()

  const onMerge = () => handleMerge()
  const onAutoResolve = () => handleMerge('auto')
  const onShowManualResolve = () => setShowManualResolve(true)
  const onMergeToolChange = (t: string) => {
    setMergeTool(t)
    setMergeModel('')
  }
  const onMergeModelChange = setMergeModel
  const onToggleLog = (id: string) => setActiveLogId(activeLogId === id ? null : id)

  const latestFailedMergeId =
    mergeInteractions.find((item) => item.status === 'failed')?.id ?? null
  const latestRunningMergeId =
    mergeInteractions.find((item) => item.status === 'running')?.id ?? null

  return (
    <div className="flex flex-col gap-2.5">
      {readOnly && !mergeProgress && !conflictError && mergeInteractions.length === 0 && (
        <div className="text-xs text-[var(--text-secondary)]">
          Merge details are read-only for completed tasks.
        </div>
      )}

      {!readOnly && (
        <div className="flex justify-end">
          <ActionButton variant="primary" onClick={onMerge} disabled={merging}>
            {merging ? 'Merging…' : conflictError ? 'Retry Merge' : 'Merge'}
          </ActionButton>
        </div>
      )}

      {mergeInteractions.length === 0 && !mergeProgress && !conflictError && (
        <div className="text-xs text-[var(--text-secondary)]">No merge interactions yet.</div>
      )}

      {mergeInteractions.map((item) => (
        <InteractionEntry
          key={item.id}
          interaction={item}
          activeLogId={activeLogId}
          onToggleLog={onToggleLog}
        >
          {item.id === latestRunningMergeId && item.status === 'running' && mergeProgress && (
            <div className="rounded-md border border-[#e0b4b4] bg-[#fff5f5] p-2 text-xs leading-5 text-[#8a1f1f]">
              {mergeProgress}
            </div>
          )}

          {item.id === latestFailedMergeId && item.status === 'failed' && conflictError && (
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
                    <ActionButton variant="primary" onClick={onAutoResolve} disabled={merging}>
                      Auto-resolve
                    </ActionButton>
                  </div>
                  <ActionButton variant="default" onClick={onShowManualResolve}>
                    Manual resolve
                  </ActionButton>
                </div>
              )}
              {showManualResolve && (
                <div className="flex flex-col gap-1.5 text-xs text-[var(--text-secondary)]">
                  {conflictWorktreePath && (
                    <div className="font-mono text-[11px] text-[var(--text-primary)]">
                      Worktree: <code>{conflictWorktreePath}</code>
                    </div>
                  )}
                  <div>
                    Resolve conflicts in the worktree, commit the fixes, then click Retry Merge.
                  </div>
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
