import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ActionButton } from '../../common/ActionButton'
import { ToolModelSelector } from '../../common/ToolModelSelector'
import { InteractionEntry } from './InteractionEntry'
import { useTaskDetailContext } from '../../../context/TaskDetailContext'

interface Props {
  readOnly?: boolean
}

function formatRelativeTime(iso: string): string {
  const timestamp = Date.parse(iso)
  if (!Number.isFinite(timestamp)) return 'just now'
  const deltaSeconds = Math.round((timestamp - Date.now()) / 1000)
  const absDeltaSeconds = Math.abs(deltaSeconds)
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (absDeltaSeconds < 60) return rtf.format(deltaSeconds, 'second')
  if (absDeltaSeconds < 3600)
    return rtf.format(Math.round(deltaSeconds / 60), 'minute')
  if (absDeltaSeconds < 86400)
    return rtf.format(Math.round(deltaSeconds / 3600), 'hour')
  return rtf.format(Math.round(deltaSeconds / 86400), 'day')
}

export function TaskPlanSection({ readOnly = false }: Props) {
  const {
    task,
    hasPlan,
    planGenerating,
    planLoading,
    planError,
    approvingPlan,
    requestingPlanChanges,
    planFeedback,
    setPlanFeedback,
    planReviewExpanded,
    setPlanReviewExpanded,
    taskEvaluation,
    evaluatingTask,
    tools,
    generateTool,
    setGenerateTool,
    generateModel,
    setGenerateModel,
    generationModels,
    generateModelsFetching,
    generatePlanPending,
    controlClass,
    planInteractions,
    planReviews,
    activeLogId,
    setActiveLogId,
    handleGeneratePlan,
    handleEvaluateTask,
    handleApprovePlan,
    handleRequestPlanChanges,
  } = useTaskDetailContext()
  const [expandedPlans, setExpandedPlans] = useState<Set<string>>(new Set())
  const canGenerate = task.status === 'pending' && !hasPlan
  const canReviewPlan = task.status === 'pending' && hasPlan
  const hasRunningPlan = planInteractions.some((item) => item.status === 'running')
  const latestCompletedId =
    [...planInteractions].reverse().find((item) => item.status === 'completed')?.id ?? null

  useEffect(() => {
    if (latestCompletedId) {
      setExpandedPlans(new Set([latestCompletedId]))
      return
    }
    setExpandedPlans(new Set())
  }, [latestCompletedId])

  function togglePlan(id: string) {
    setExpandedPlans((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
      {!readOnly && (
        <div
          className={[
            'grid grid-cols-1 items-center gap-2',
            canGenerate
              ? 'sm:grid-cols-[1fr_1fr_auto_auto]'
              : 'sm:grid-cols-[1fr_1fr_auto]',
          ].join(' ')}
        >
          <ToolModelSelector
            tools={tools}
            selectedTool={generateTool}
            selectedModel={generateModel}
            models={generationModels}
            modelsFetching={generateModelsFetching}
            onToolChange={setGenerateTool}
            onModelChange={setGenerateModel}
            controlClass={controlClass}
            modelPlaceholder="- default generation model"
            className="contents"
          />
          {canGenerate && (
            <ActionButton
              variant="primary"
              onClick={handleGeneratePlan}
              disabled={planGenerating || planLoading || generatePlanPending}
            >
              {planGenerating ? 'Generating…' : 'Generate Plan'}
            </ActionButton>
          )}
          <ActionButton
            variant="default"
            onClick={handleEvaluateTask}
            disabled={
              evaluatingTask ||
              planLoading ||
              planGenerating ||
              generatePlanPending
            }
          >
            {evaluatingTask ? 'Evaluating…' : 'Evaluate'}
          </ActionButton>
        </div>
      )}

      {taskEvaluation && (
        <div className="flex flex-col gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-2.5">
          <div className="text-xs text-[var(--text-primary)]">
            Complexity:{' '}
            <span className="font-medium">{taskEvaluation.complexity}</span>
          </div>
          <div className="text-xs text-[var(--text-primary)]">
            Should decompose:{' '}
            <span className="font-medium">
              {taskEvaluation.should_decompose ? 'Yes' : 'No'}
            </span>
          </div>
          <div className="text-xs text-[var(--text-secondary)]">Reasoning</div>
          <div className="whitespace-pre-wrap text-xs text-[var(--text-primary)]">
            {taskEvaluation.reasoning}
          </div>
        </div>
      )}

      {planLoading && <div className="text-xs text-[var(--text-secondary)]">Loading plan...</div>}
      {!planLoading && !hasPlan && planInteractions.length === 0 && (
        <div className="text-xs text-[var(--text-secondary)]">No plan saved yet.</div>
      )}

      {!planLoading && hasPlan && planInteractions.length === 0 && (
        <div className="text-xs text-[var(--text-secondary)]">No planning interactions yet.</div>
      )}

      {!planLoading && planInteractions.length > 0 && (
        <div className="flex flex-col gap-2">
          {planInteractions.map((item) => {
            const itemReviews = planReviews.filter((review) => review.interaction_id === item.id)
            const isLatestCompleted =
              item.status === 'completed' && item.id === latestCompletedId
            return (
              <InteractionEntry
                key={item.id}
                interaction={item}
                activeLogId={activeLogId}
                onToggleLog={(id) => setActiveLogId(activeLogId === id ? null : id)}
              >
                {item.status === 'completed' && item.diff && (
                  <>
                    <button
                      type="button"
                      className="text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                      onClick={() => togglePlan(item.id)}
                    >
                      {expandedPlans.has(item.id) ? '▾ Hide plan' : '▸ Show plan'}
                    </button>
                    {expandedPlans.has(item.id) && (
                      <div className="prose prose-invert prose-sm max-w-none max-h-[300px] overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-2.5 text-xs text-[var(--text-primary)]">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.diff}</ReactMarkdown>
                      </div>
                    )}
                  </>
                )}

                {item.status === 'completed' && itemReviews.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    {itemReviews.map((review) => (
                      <div
                        key={review.id}
                        className={[
                          'rounded-md border p-2.5',
                          review.status === 'pending'
                            ? 'border-amber-500/40 bg-amber-500/10'
                            : 'border-emerald-500/35 bg-emerald-500/10 opacity-80',
                        ].join(' ')}
                      >
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <span className="text-[10px] font-semibold uppercase tracking-[0.05em] text-[var(--text-secondary)]">
                            {review.status}
                          </span>
                          <span className="text-[11px] text-[var(--text-secondary)]">
                            {formatRelativeTime(review.created_at)}
                          </span>
                        </div>
                        <div className="whitespace-pre-wrap text-xs text-[var(--text-primary)]">
                          {review.feedback}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {isLatestCompleted && canReviewPlan && !readOnly && !hasRunningPlan && (
                  <div className="flex flex-col gap-2.5">
                    <div className="flex justify-end gap-2">
                      <ActionButton
                        variant="primary"
                        onClick={handleApprovePlan}
                        disabled={approvingPlan || requestingPlanChanges}
                      >
                        {approvingPlan ? 'Approving…' : 'Approve Plan'}
                      </ActionButton>
                      {!planReviewExpanded && (
                        <ActionButton
                          variant="default"
                          onClick={() => setPlanReviewExpanded(true)}
                          disabled={approvingPlan || requestingPlanChanges}
                        >
                          Request Changes
                        </ActionButton>
                      )}
                    </div>

                    {planReviewExpanded && (
                      <div className="flex flex-col gap-2.5 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-2.5">
                        <textarea
                          className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-2.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                          value={planFeedback}
                          onChange={(e) => setPlanFeedback(e.target.value)}
                          rows={4}
                          placeholder="Describe what should change in the plan..."
                        />
                        <div className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[1fr_1fr]">
                          <ToolModelSelector
                            tools={tools}
                            selectedTool={generateTool}
                            selectedModel={generateModel}
                            models={generationModels}
                            modelsFetching={generateModelsFetching}
                            onToolChange={setGenerateTool}
                            onModelChange={setGenerateModel}
                            controlClass={controlClass}
                            modelPlaceholder="- default generation model"
                            className="contents"
                          />
                        </div>
                        <div className="flex justify-end gap-2">
                          <ActionButton
                            variant="default"
                            onClick={() => setPlanReviewExpanded(false)}
                            disabled={requestingPlanChanges}
                          >
                            Cancel
                          </ActionButton>
                          <ActionButton
                            variant="primary"
                            onClick={() =>
                              handleRequestPlanChanges(
                                item.id,
                                planFeedback,
                                generateTool || undefined,
                                generateModel || undefined,
                              )
                            }
                            disabled={requestingPlanChanges || planGenerating || generatePlanPending}
                          >
                            {requestingPlanChanges ? 'Submitting…' : 'Submit'}
                          </ActionButton>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </InteractionEntry>
            )
          })}
        </div>
      )}

      {planError && <div className="text-xs text-[var(--status-failed)]">{planError}</div>}
    </div>
  )
}
