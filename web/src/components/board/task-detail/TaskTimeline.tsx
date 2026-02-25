import { TaskExecutionSection } from './TaskExecutionSection'
import { TaskMergeStatus } from './TaskMergeStatus'
import { TaskPlanSection } from './TaskPlanSection'
import { TimelinePhase } from './TimelinePhase'
import { useTaskDetailContext } from '../../../context/TaskDetailContext'
import type { Task } from '../../../types'

type PhaseState = 'disabled' | 'active' | 'completed'

function stateFor(task: Task, phase: 'planning' | 'execution' | 'merge'): PhaseState {
  if (phase === 'planning') {
    return task.status === 'pending' ? 'active' : 'completed'
  }

  if (phase === 'execution') {
    if (task.status === 'pending') return 'disabled'
    if (task.status === 'planned') return 'active'
    if (task.status === 'running' || task.status === 'review' || task.status === 'failed') {
      return 'active'
    }
    if (task.status === 'approved' || task.status === 'merged') return 'completed'
    return 'disabled'
  }

  if (phase === 'merge') {
    if (task.status === 'approved') return 'active'
    if (task.status === 'merged') return 'completed'
    return 'disabled'
  }

  return 'disabled'
}

export function TaskTimeline() {
  const { task, plan, config } = useTaskDetailContext()
  const taskForPhaseState = { ...task, plan: plan ?? task.plan }
  const planningState = stateFor(taskForPhaseState, 'planning')
  const executionState = stateFor(taskForPhaseState, 'execution')
  const mergeState = stateFor(taskForPhaseState, 'merge')
  const hasDefaultTool = (config.tools?.length ?? 0) > 0

  return (
    <div className="relative pl-8">
      <div className="absolute left-3 top-0 bottom-0 w-px bg-[var(--border)]" />

      <TimelinePhase phase="planning" state={planningState}>
        {!hasDefaultTool && (
          <div className="mb-2 text-[11px] text-[var(--text-secondary)]">
            No tool configured.
          </div>
        )}
        <TaskPlanSection readOnly={planningState !== 'active'} />
      </TimelinePhase>

      <TimelinePhase phase="execution" state={executionState}>
        <TaskExecutionSection readOnly={executionState !== 'active'} />
      </TimelinePhase>

      <TimelinePhase phase="merge" state={mergeState}>
        <TaskMergeStatus readOnly={mergeState !== 'active'} />
      </TimelinePhase>
    </div>
  )
}
