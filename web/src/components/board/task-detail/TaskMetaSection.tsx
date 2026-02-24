import type { Config } from '../../../types'
import type { useTaskForm } from '../../../hooks/forms/useTaskForm'
import { PhaseConfigFields } from '../PhaseConfigFields'

const PHASES: Array<'plan' | 'run' | 'review'> = ['plan', 'run', 'review']

interface Props {
  taskTitle: string
  taskDependencies: string[]
  isEditable: boolean
  controlClass: string
  form: ReturnType<typeof useTaskForm>
  config: Config
}

function phaseLabel(phase: 'plan' | 'run' | 'review') {
  return phase[0].toUpperCase() + phase.slice(1)
}

export function TaskMetaSection({
  taskTitle,
  taskDependencies,
  isEditable,
  controlClass,
  form,
  config,
}: Props) {
  const tools = Object.keys(config.tools)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))

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

      <form.Field name="useDefaults">
        {(field) => (
          <div className="flex flex-col gap-2">
            {isEditable ? (
              <label className="flex items-center gap-2 text-xs font-medium text-[var(--text-secondary)]">
                <input
                  type="checkbox"
                  checked={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => {
                    const checked = e.target.checked
                    field.handleChange(checked)
                    if (!checked) {
                      const defaultTool = config.defaults?.tool ?? ''
                      const defaultModel = config.defaults?.model ?? ''
                      form.setFieldValue('phases', {
                        plan: { tool: defaultTool, model: defaultModel },
                        run: { tool: defaultTool, model: defaultModel },
                        review: { tool: defaultTool, model: defaultModel },
                      })
                    }
                  }}
                />
                Use configured defaults
              </label>
            ) : null}

            {field.state.value ? (
              <p className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-xs text-[var(--text-secondary)]">
                Using configured defaults
              </p>
            ) : isEditable ? (
              <form.Field name="phases">
                {(phaseField) => (
                  <PhaseConfigFields
                    tools={tools}
                    config={config}
                    phases={phaseField.state.value}
                    onChange={(nextPhases) => phaseField.handleChange(nextPhases as any)}
                    controlClass={controlClass}
                  />
                )}
              </form.Field>
            ) : (
              <form.Field name="phases">
                {(phaseField) => (
                  <div className="overflow-x-auto rounded-md border border-[var(--border)]">
                    <table className="min-w-full border-collapse">
                      <thead className="bg-[var(--bg-secondary)]">
                        <tr>
                          <th className="px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
                            Phase
                          </th>
                          <th className="px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
                            Tool
                          </th>
                          <th className="px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
                            Model
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {PHASES.map((phase) => {
                          const value = phaseField.state.value[phase] ?? {
                            tool: '',
                            model: '',
                          }
                          return (
                            <tr
                              key={phase}
                              className="border-b border-[var(--border)] last:border-b-0"
                            >
                              <td className="px-2 py-2 text-xs text-[var(--text-primary)]">
                                {phaseLabel(phase)}
                              </td>
                              <td className="px-2 py-2 font-mono text-[12px] text-[var(--text-primary)]">
                                {value.tool || 'inherit default'}
                              </td>
                              <td className="px-2 py-2 font-mono text-[12px] text-[var(--text-primary)]">
                                {value.model || 'inherit default'}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </form.Field>
            )}
          </div>
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
