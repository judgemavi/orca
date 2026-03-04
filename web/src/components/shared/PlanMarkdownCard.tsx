import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { parsePlanSections } from '../../lib/orchestratorRichContent'

interface PlanMarkdownCardProps {
  planText: string
  taskId?: string
  saved?: boolean
  collapsible?: boolean
}

export function PlanMarkdownCard({
  planText,
  taskId,
  saved,
  collapsible = false,
}: PlanMarkdownCardProps) {
  const trimmedPlan = planText.trim()
  const sections = parsePlanSections(trimmedPlan)

  if (!trimmedPlan) {
    return <div className="text-xs text-muted">(empty plan)</div>
  }

  return (
    <div className="space-y-2">
      {(taskId || saved !== undefined) && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
          {taskId ? (
            <span>
              task: <span className="font-mono">{taskId.slice(0, 8)}</span>
            </span>
          ) : null}
          {saved !== undefined ? (
            <span
              className={[
                'rounded px-1.5 py-0.5',
                saved ? 'bg-emerald-500/15 text-emerald-700' : 'bg-amber-500/15 text-amber-700',
              ].join(' ')}
            >
              {saved ? 'saved' : 'not saved'}
            </span>
          ) : null}
        </div>
      )}

      {collapsible ? (
        sections.map((section, index) => (
          <details
            key={section.key}
            className="rounded-md border border-border-subtle bg-surface-alt/40"
            open={index === 0}
          >
            <summary className="cursor-pointer px-2 py-1.5 text-xs font-medium">
              {section.title}
            </summary>
            <div className="border-t border-border-subtle px-2 py-2">
              <div className="prose prose-sm max-w-none dark:prose-invert">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{section.content}</ReactMarkdown>
              </div>
            </div>
          </details>
        ))
      ) : (
        <div className="prose prose-sm max-h-[300px] max-w-none overflow-auto rounded-lg bg-surface p-4 text-xs dark:prose-invert">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{trimmedPlan}</ReactMarkdown>
        </div>
      )}
    </div>
  )
}
