import { useEffect, useMemo, useState } from 'react'
import type { ProposedTask } from '../../types'
import { api } from '../../api'
import { ToolChip } from '../common/ToolChip'
import { ActionButton } from '../common/ActionButton'

interface Props {
  data: {
    goal: string
    proposed_tasks: ProposedTask[]
    actions: string[]
    session_id?: string
    proposal_id?: string
    operation_id?: string
  }
  sessionId: string
  proposalId: string
  actioned?: boolean
  onActioned?: (proposalId: string) => void
}

const DEFAULT_TOOLS = ['claude', 'codex', 'cursor', 'gemini']

export function PlanProposal({
  data,
  sessionId,
  proposalId,
  actioned = false,
  onActioned,
}: Props) {
  const goal = data?.goal ?? ''
  const proposedTasks = data?.proposed_tasks ?? []
  const actions = data?.actions ?? []
  const [tasks, setTasks] = useState<ProposedTask[]>(proposedTasks)
  const [localActioned, setLocalActioned] = useState(actioned)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setTasks(proposedTasks)
  }, [proposedTasks])

  useEffect(() => {
    if (actioned) {
      setLocalActioned(true)
    }
  }, [actioned])

  const toolOptions = useMemo(() => {
    const fromTasks = tasks.map((t) => t.suggested_tool).filter(Boolean)
    return Array.from(new Set([...DEFAULT_TOOLS, ...fromTasks]))
  }, [tasks])

  const updateTask = (index: number, patch: Partial<ProposedTask>) => {
    setTasks((prev) =>
      prev.map((task, i) => (i === index ? { ...task, ...patch } : task)),
    )
  }

  const removeTask = (index: number) => {
    setTasks((prev) => {
      const next = prev.filter((_, i) => i !== index)
      return next.map((task) => ({
        ...task,
        depends_on_indices: (task.depends_on_indices ?? [])
          .filter((dep) => dep !== index)
          .map((dep) => (dep > index ? dep - 1 : dep)),
      }))
    })
  }

  const markActioned = () => {
    setLocalActioned(true)
    onActioned?.(proposalId)
  }

  const handleApprove = async () => {
    if (submitting || localActioned) return
    setSubmitting(true)
    setError('')
    try {
      const operationId = data.operation_id ?? proposalId
      if (!operationId) {
        throw new Error('Missing decompose operation id')
      }
      await api.acceptPlan(operationId, tasks, data.session_id ?? sessionId)
      markActioned()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to accept plan')
    } finally {
      setSubmitting(false)
    }
  }

  const handleReject = async () => {
    if (submitting || localActioned) return
    setSubmitting(true)
    setError('')
    try {
      const operationId = data.operation_id ?? proposalId
      if (!operationId) {
        throw new Error('Missing decompose operation id')
      }
      await api.rejectPlan(operationId, data.session_id ?? sessionId)
      markActioned()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reject plan')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-slate-700 bg-slate-900 p-4">
      <div className="text-[15px] font-semibold">Plan: "{goal}"</div>
      <div className="flex flex-col gap-3">
        {tasks.map((task, i) => (
          <div
            key={i}
            className="flex flex-col gap-1 border-l-2 border-slate-700 pl-2"
          >
            <div className="flex items-center gap-2">
              <span className="min-w-5 text-sm font-bold text-slate-400">
                {i + 1}.
              </span>
              <input
                className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm font-medium text-slate-100"
                value={task.title}
                onChange={(e) => updateTask(i, { title: e.target.value })}
                placeholder="Task title"
              />
              <select
                className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-100"
                value={task.suggested_tool ?? ''}
                onChange={(e) =>
                  updateTask(i, { suggested_tool: e.target.value })
                }
              >
                <option value="">No preference</option>
                {toolOptions.map((tool) => (
                  <option key={tool} value={tool}>
                    {tool}
                  </option>
                ))}
              </select>
              {task.suggested_tool && <ToolChip tool={task.suggested_tool} />}
              <button
                className="h-6 w-6 rounded-md border border-slate-700 bg-transparent text-slate-400 hover:border-rose-500 hover:text-rose-500"
                onClick={() => removeTask(i)}
                aria-label={`Remove task ${i + 1}`}
                type="button"
              >
                ×
              </button>
            </div>
            <textarea
              className="w-full resize-y rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-[13px] leading-[1.4] text-slate-300"
              value={task.description}
              onChange={(e) => updateTask(i, { description: e.target.value })}
              placeholder="Task description"
              rows={2}
            />
            {(task.depends_on_indices ?? []).length > 0 && (
              <div className="text-xs italic text-slate-400">
                depends on:{' '}
                {(task.depends_on_indices ?? [])
                  .map((d) => `#${d + 1}`)
                  .join(', ')}
              </div>
            )}
          </div>
        ))}
      </div>
      {error && <div className="text-xs text-rose-500">{error}</div>}
      {!localActioned && actions.length > 0 && (
        <div className="flex justify-end gap-2">
          {actions.map((a) => {
            const isApprove = a.toLowerCase().includes('approve')
            return (
              <ActionButton
                key={a}
                label={a}
                variant={isApprove ? 'primary' : 'default'}
                disabled={submitting}
                onClick={isApprove ? handleApprove : handleReject}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
