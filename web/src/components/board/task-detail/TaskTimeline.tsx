import type { ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { TaskExecutionSection } from './TaskExecutionSection'
import { TaskMergeStatus } from './TaskMergeStatus'
import { TaskPlanSection } from './TaskPlanSection'
import {
  TimelinePhase,
  type TimelinePhaseId,
  type TimelinePhaseState,
} from './TimelinePhase'
import { useTaskDetailContext } from '../../../context/TaskDetailContext'
import { useTaskPlanQuery } from '../../../hooks/queries/usePlan'
import { selectByPhase, useInteractionsQuery } from './useInteractions'
import type { Interaction, Task } from '../../../types'

const PHASES: TimelinePhaseId[] = ['planning', 'execution', 'merge']

function formatCost(value: number): string {
  if (!Number.isFinite(value)) return '$0.00'
  return `$${value.toFixed(2)}`
}

function formatDuration(durationMs?: number): string | null {
  if (!Number.isFinite(durationMs) || !durationMs || durationMs < 0) return null
  if (durationMs < 1000) return `${durationMs}ms`
  return `${(durationMs / 1000).toFixed(1)}s`
}

function pluralize(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
}

function diffSummary(diff?: string): string | null {
  if (!diff?.trim()) return null
  let added = 0
  let removed = 0

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue
    if (line.startsWith('+')) added += 1
    if (line.startsWith('-')) removed += 1
  }

  return `+${added}/-${removed} lines`
}

function latestInteraction(interactions: Interaction[]): Interaction | null {
  if (interactions.length === 0) return null
  return [...interactions].sort(
    (a, b) => Date.parse(b.started_at) - Date.parse(a.started_at),
  )[0]
}

function defaultPhaseFor(
  task: Task,
  hasPlan: boolean,
  hasFailedMerge: boolean,
): TimelinePhaseId {
  if (task.status === 'pending') return 'planning'
  if (task.status === 'planned') return 'planning'
  if (task.status === 'running' || task.status === 'review') return 'execution'
  if (task.status === 'approved') return 'merge'
  if (task.status === 'merged') return 'merge'
  if (task.status === 'failed') return hasFailedMerge ? 'merge' : 'execution'
  return hasPlan ? 'execution' : 'planning'
}

function stateFor(
  task: Task,
  hasPlan: boolean,
  hasFailedMerge: boolean,
  phase: TimelinePhaseId,
): TimelinePhaseState {
  const failedPhase = hasFailedMerge ? 'merge' : 'execution'

  if (task.status === 'failed' && phase === failedPhase) return 'failed'

  if (phase === 'planning') {
    if (task.status === 'pending') return 'active'
    if (task.status === 'planned' && !hasPlan) return 'active'
    return 'completed'
  }

  if (phase === 'execution') {
    if (task.status === 'pending') return 'pending'
    if (task.status === 'planned') return hasPlan ? 'active' : 'pending'
    if (task.status === 'running' || task.status === 'review') return 'active'
    if (task.status === 'approved' || task.status === 'merged')
      return 'completed'
    return 'pending'
  }

  if (phase === 'merge') {
    if (task.status === 'approved') return 'active'
    if (task.status === 'merged') return 'completed'
    return 'pending'
  }

  return 'pending'
}

function connectorClass(state: TimelinePhaseState): string {
  if (state === 'completed') return 'bg-success'
  if (state === 'active') return 'bg-accent'
  if (state === 'failed') return 'bg-danger'
  return 'border-t border-dashed border-border-subtle'
}

export function TaskTimeline({ children }: { children?: ReactNode }) {
  const { task, config } = useTaskDetailContext()
  const taskPlanQuery = useTaskPlanQuery(task.id)
  const runInteractionsQuery = useInteractionsQuery(task.id, {
    select: selectByPhase('run'),
  })
  const planInteractionsQuery = useInteractionsQuery(task.id, {
    select: selectByPhase('plan'),
  })
  const mergeInteractionsQuery = useInteractionsQuery(task.id, {
    select: selectByPhase('merge'),
  })

  const hasPlan = Boolean(taskPlanQuery.data?.trim())
  const runInteractions = runInteractionsQuery.data ?? []
  const planInteractions = planInteractionsQuery.data ?? []
  const mergeInteractions = mergeInteractionsQuery.data ?? []
  const hasFailedMerge = mergeInteractions.some((item) => item.status === 'failed')
  const defaultPhase = defaultPhaseFor(task, hasPlan, hasFailedMerge)

  const [selectedPhase, setSelectedPhase] = useState<TimelinePhaseId>(defaultPhase)
  const [displayedPhase, setDisplayedPhase] = useState<TimelinePhaseId>(defaultPhase)
  const [contentVisible, setContentVisible] = useState(true)

  useEffect(() => {
    setSelectedPhase(defaultPhase)
  }, [defaultPhase])

  useEffect(() => {
    if (selectedPhase === displayedPhase) return
    setContentVisible(false)
    const timeoutId = window.setTimeout(() => {
      setDisplayedPhase(selectedPhase)
      window.requestAnimationFrame(() => {
        setContentVisible(true)
      })
    }, 120)
    return () => window.clearTimeout(timeoutId)
  }, [selectedPhase, displayedPhase])

  const phaseStates = useMemo<Record<TimelinePhaseId, TimelinePhaseState>>(
    () => ({
      planning: stateFor(task, hasPlan, hasFailedMerge, 'planning'),
      execution: stateFor(task, hasPlan, hasFailedMerge, 'execution'),
      merge: stateFor(task, hasPlan, hasFailedMerge, 'merge'),
    }),
    [task, hasPlan, hasFailedMerge],
  )

  const planningSummary = useMemo(() => {
    const interactions = planInteractions.length
    const totalCost = planInteractions.reduce(
      (sum, item) => sum + (item.estimated_cost ?? 0),
      0,
    )
    return `${pluralize(interactions, 'interaction')} · ${formatCost(totalCost)}`
  }, [planInteractions])

  const executionSummary = useMemo(() => {
    const latest = latestInteraction(runInteractions)
    const duration = formatDuration(latest?.duration_ms)
    const diff = diffSummary(latest?.diff)
    const parts = [pluralize(runInteractions.length, 'interaction')]
    if (duration) parts.push(duration)
    if (diff) parts.push(diff)
    return parts.join(' · ')
  }, [runInteractions])

  const mergeSummary = useMemo(() => {
    if (task.status === 'merged') {
      return `merged to ${config.project.integration_branch || 'main'}`
    }
    return 'pending'
  }, [task.status, config.project.integration_branch])

  const phaseSummaries: Record<TimelinePhaseId, string> = {
    planning: planningSummary,
    execution: executionSummary,
    merge: mergeSummary,
  }

  const hasDefaultTool = (config.tools?.length ?? 0) > 0

  function renderSelectedContent() {
    if (displayedPhase === 'planning') {
      return (
        <>
          {!hasDefaultTool && (
            <div className="mb-2 text-[11px]">No tool configured.</div>
          )}
          <TaskPlanSection readOnly={phaseStates.planning !== 'active'} />
        </>
      )
    }

    if (displayedPhase === 'execution') {
      return <TaskExecutionSection readOnly={phaseStates.execution !== 'active'} />
    }

    return <TaskMergeStatus readOnly={phaseStates.merge !== 'active'} />
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-h-12 items-center rounded-lg border border-border-subtle bg-surface px-3">
        {PHASES.map((phase, index) => (
          <div key={phase} className="flex min-w-0 flex-1 items-center gap-2">
            <TimelinePhase
              phase={phase}
              state={phaseStates[phase]}
              selected={selectedPhase === phase}
              summary={phaseSummaries[phase]}
              onSelect={setSelectedPhase}
            />
            {index < PHASES.length - 1 && (
              <div
                className={[
                  'h-px flex-1',
                  connectorClass(phaseStates[phase]),
                ].join(' ')}
              />
            )}
          </div>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 gap-4">
        <div
          className={[
            'min-h-0 flex-1 overflow-auto transition-all duration-200',
            contentVisible ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0',
          ].join(' ')}
        >
          {renderSelectedContent()}
        </div>
        {children}
      </div>
    </div>
  )
}
