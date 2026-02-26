import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../../api'
import { useTaskDetailContext } from '../../../context/TaskDetailContext'
import { useModelsQuery } from '../../../hooks/queries/useModels'
import { controlClass } from '../../../lib/constants'
import { getErrorMessage } from '../../../lib/utils'
import { ActionButton } from '../../common/ActionButton'
import { ToolModelSelector } from '../../common/ToolModelSelector'

export function FailedRunActions() {
  const { task, tools } = useTaskDetailContext()
  const [rerunTool, setRerunTool] = useState('')
  const [rerunModel, setRerunModel] = useState('')
  const [rerunError, setRerunError] = useState<string | null>(null)

  const rerunModelsQuery = useModelsQuery(rerunTool || undefined)
  const runTaskMutation = useMutation({
    mutationFn: (args: { taskId: string; tool?: string; model?: string }) =>
      api.runTasks([args.taskId], args.tool, args.model),
  })
  const rerunModels = rerunTool
    ? (rerunModelsQuery.data?.[rerunTool] ?? [])
    : []

  const handleRerun = async () => {
    setRerunError(null)
    try {
      await runTaskMutation.mutateAsync({
        taskId: task.id,
        tool: rerunTool || undefined,
        model: rerunModel || undefined,
      })
    } catch (err: unknown) {
      setRerunError(getErrorMessage(err, 'Re-run failed'))
    }
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-md border border-danger/30 bg-danger/10 p-3">
      <div className="text-xs">
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
      {rerunError && <div className="text-xs">{rerunError}</div>}
    </div>
  )
}
