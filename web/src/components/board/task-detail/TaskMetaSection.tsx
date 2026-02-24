import type { useTaskForm } from '../../../hooks/forms/useTaskForm'

interface Props {
  taskTitle: string
  taskDependencies: string[]
  isEditable: boolean
  controlClass: string
  form: ReturnType<typeof useTaskForm>
}

export function TaskMetaSection({
  taskTitle,
  taskDependencies,
  isEditable,
  controlClass,
  form,
}: Props) {
  return (
    <>
      <form.Field name="title">
        {(field) => (
          <label className="flex flex-col gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
            Title
            {isEditable ? (
              <input
                className={controlClass}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            ) : (
              <p className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-2 text-[13px] font-normal text-[var(--text-primary)]">
                {field.state.value || taskTitle}
              </p>
            )}
          </label>
        )}
      </form.Field>

      <form.Field name="description">
        {(field) => (
          <label className="flex flex-col gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
            Description
            {isEditable ? (
              <textarea
                className={controlClass}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                rows={4}
                placeholder="No description"
              />
            ) : (
              <div className="min-h-[80px] whitespace-pre-wrap rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-2 text-[13px] font-normal text-[var(--text-primary)]">
                {field.state.value || 'No description'}
              </div>
            )}
          </label>
        )}
      </form.Field>

      {taskDependencies.length > 0 && (
        <div className="flex flex-col gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
          Dependencies
          <div className="flex flex-wrap gap-1.5">
            {taskDependencies.map((depId) => (
              <span
                key={depId}
                className="rounded border border-[var(--border)] bg-[var(--bg-sidebar)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--text-secondary)]"
              >
                {depId.slice(0, 8)}
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
