import { useState } from 'react'
import { useTaskDetailContext } from '../../../context/TaskDetailContext'
import { useModelsQuery } from '../../../hooks/queries/useModels'
import { useRunTaskMutation } from '../../../hooks/queries/useTaskMutations'
import { controlClass } from '../../../lib/constants'
import { ActionButton } from '../../common/ActionButton'
import { ToolModelSelector } from '../../common/ToolModelSelector'

function getErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}

export function FailedRunActions() {
  const { task, tools, onSaved } = useTaskDetailContext()
  const [rerunTool, setRerunTool] = useState('')
  const [rerunModel, setRerunModel] = useState('')
  const [rerunError, setRerunError] = useState<string | null>(null)

  const rerunModelsQuery = useModelsQuery(rerunTool || undefined)
  const runTaskMutation = useRunTaskMutation()
  const rerunModels = rerunTool ? (rerunModelsQuery.data?.[rerunTool] ?? []) : []

  const handleRerun = async () => {
    setRerunError(null)
    try {
      await runTaskMutation.mutateAsync({
        taskId: task.id,
        tool: rerunTool || undefined,
        model: rerunModel || undefined,
      })
      onSaved()
    } catch (err: unknown) {
      setRerunError(getErrorMessage(err, 'Re-run failed'))
    }
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-md border border-[var(--status-failed)]/30 bg-[var(--status-failed)]/10 p-3">
      <div className="text-xs text-[var(--text-primary)]">
        Execution failed. Re-run this task to generate a new result.
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <ToolModelSelector
          tools={tools}
          selectedTool={rerunTool}
          selectedModel={rerunModel}
          models={rerunModels}
          modelsFetching={rerunModelsQuery.isFetching}
          onToolChange={(tool) => {
            setRerunTool(tool)
            setRerunModel('')
          }}
          onModelChange={setRerunModel}
          controlClass={controlClass}
          toolPlaceholder="- phase/default tool"
          modelPlaceholder="- default model"
          className="contents"
        />
        <ActionButton
          variant="primary"
          onClick={handleRerun}
          disabled={runTaskMutation.isPending}
        >
          {runTaskMutation.isPending ? 'Re-running…' : 'Re-run'}
        </ActionButton>
      </div>
      {rerunError && <div className="text-xs text-[var(--status-failed)]">{rerunError}</div>}
    </div>
  )
}
