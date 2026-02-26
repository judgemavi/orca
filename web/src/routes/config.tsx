import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { useConfigQuery } from '../hooks/queries/useConfig'
import { useModelsQuery } from '../hooks/queries/useModels'
import type { Config } from '../types'

type SectionId =
  | 'project'
  | 'tools'
  | 'workers'
  | 'orchestrator'
  | 'monitor'
  | 'quality'
  | 'logging'

type SectionCardProps = {
  title: string
  id: SectionId
  saving?: boolean
  error?: string | null
  onSave: () => void
  children: React.ReactNode
}

type LabeledInputProps = {
  label: string
  value: string
  onChange: (next: string) => void
  type?: React.InputHTMLAttributes<HTMLInputElement>['type']
}

type ToggleProps = {
  label: string
  checked: boolean
  onChange: (next: boolean) => void
}

const inputClass =
  'w-full rounded-md border px-2.5 py-2 text-[13px] outline-none transition-colors focus:border-accent'

const sectionClass = 'rounded-lg border'

export function ConfigPage() {
  const { data, isLoading } = useConfigQuery()
  const { data: modelsByTool = {} } = useModelsQuery()
  const [draft, setDraft] = useState<Config | null>(null)
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [errors, setErrors] = useState<Record<string, string | null>>({})

  useEffect(() => {
    if (data) setDraft(data)
  }, [data])

  const toolOptions = useMemo(() => {
    const configuredTools = draft?.tools ?? []
    const discoveredTools = Object.keys(modelsByTool)
    return Array.from(new Set([...configuredTools, ...discoveredTools])).sort(
      (a, b) => a.localeCompare(b),
    )
  }, [draft, modelsByTool])

  const updateSection = <K extends keyof Config>(
    section: K,
    value: Config[K],
  ) => {
    setDraft((prev) => (prev ? { ...prev, [section]: value } : prev))
  }

  const savePatch = async (sectionId: SectionId, patch: Partial<Config>) => {
    setSaving((prev) => ({ ...prev, [sectionId]: true }))
    setErrors((prev) => ({ ...prev, [sectionId]: null }))
    try {
      const updated = await api.updateConfig(patch)
      setDraft(updated)
    } catch (err: any) {
      setErrors((prev) => ({
        ...prev,
        [sectionId]: err?.message ?? 'Save failed',
      }))
    } finally {
      setSaving((prev) => ({ ...prev, [sectionId]: false }))
    }
  }

  if (isLoading || !draft) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-accent" />
      </div>
    )
  }

  const supervisorModels = draft.orchestrator.supervisor_tool
    ? (modelsByTool[draft.orchestrator.supervisor_tool] ?? [])
    : []

  return (
    <div className="flex flex-1 overflow-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 p-4">
        <SectionCard
          title="Project"
          id="project"
          saving={saving.project}
          error={errors.project}
          onSave={() => savePatch('project', { project: draft.project })}
        >
          <LabeledInput
            label="Name"
            value={draft.project.name}
            onChange={(value) =>
              updateSection('project', { ...draft.project, name: value })
            }
          />
          <LabeledInput
            label="Integration branch"
            value={draft.project.integration_branch}
            onChange={(value) =>
              updateSection('project', {
                ...draft.project,
                integration_branch: value,
              })
            }
          />
          <LabeledInput
            label="Worktree dir"
            value={draft.project.worktree_dir}
            onChange={(value) =>
              updateSection('project', {
                ...draft.project,
                worktree_dir: value,
              })
            }
          />
        </SectionCard>

        <SectionCard
          title="Tools"
          id="tools"
          saving={saving.tools}
          error={errors.tools}
          onSave={() => savePatch('tools', { tools: draft.tools })}
        >
          <label className="flex flex-col gap-1 text-xs">
            Enabled tools
            <div className="grid gap-2 rounded-md border p-3 sm:grid-cols-2">
              {toolOptions.map((tool) => {
                const checked = draft.tools.includes(tool)
                return (
                  <label
                    key={tool}
                    className="flex items-center gap-2 text-[13px]"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        const nextTools = e.target.checked
                          ? [...draft.tools, tool]
                          : draft.tools.filter((item) => item !== tool)
                        updateSection('tools', Array.from(new Set(nextTools)))
                      }}
                    />
                    {tool}
                  </label>
                )
              })}
            </div>
          </label>
        </SectionCard>

        <SectionCard
          title="Workers"
          id="workers"
          saving={saving.workers}
          error={errors.workers}
          onSave={() => savePatch('workers', { workers: draft.workers })}
        >
          <LabeledInput
            label="Max parallel"
            type="number"
            value={String(draft.workers.max_parallel)}
            onChange={(value) =>
              updateSection('workers', {
                max_parallel: Number(value) || 0,
              })
            }
          />
        </SectionCard>

        <SectionCard
          title="Orchestrator"
          id="orchestrator"
          saving={saving.orchestrator}
          error={errors.orchestrator}
          onSave={() =>
            savePatch('orchestrator', { orchestrator: draft.orchestrator })
          }
        >
          <div className="grid gap-3 sm:grid-cols-4">
            <label className="flex flex-col gap-1 text-xs">
              Supervisor tool
              <select
                className={inputClass}
                value={draft.orchestrator.supervisor_tool}
                onChange={(e) =>
                  updateSection('orchestrator', {
                    ...draft.orchestrator,
                    supervisor_tool: e.target.value,
                    supervisor_model: '',
                  })
                }
              >
                <option value="">Select tool</option>
                {toolOptions.map((tool) => (
                  <option key={tool} value={tool}>
                    {tool}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs">
              Supervisor model
              <select
                className={inputClass}
                value={draft.orchestrator.supervisor_model}
                onChange={(e) =>
                  updateSection('orchestrator', {
                    ...draft.orchestrator,
                    supervisor_model: e.target.value,
                  })
                }
              >
                <option value="">Select model</option>
                {supervisorModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.id}
                  </option>
                ))}
              </select>
            </label>

            <LabeledInput
              label="Cost budget"
              type="number"
              value={String(draft.orchestrator.cost_budget)}
              onChange={(value) =>
                updateSection('orchestrator', {
                  ...draft.orchestrator,
                  cost_budget: Number(value) || 0,
                })
              }
            />
            <LabeledInput
              label="Task budget"
              type="number"
              value={String(draft.orchestrator.task_budget)}
              onChange={(value) =>
                updateSection('orchestrator', {
                  ...draft.orchestrator,
                  task_budget: Number(value) || 0,
                })
              }
            />
          </div>

          <div className="space-y-2">
            <div className="text-xs">Phase overrides</div>
            {Object.entries(draft.orchestrator.phases).map(
              ([phase, override]) => {
                const phaseModels = override.tool
                  ? (modelsByTool[override.tool] ?? [])
                  : []
                return (
                  <div
                    key={phase}
                    className="grid gap-3 rounded-md border p-3 sm:grid-cols-[1fr_1fr_1fr]"
                  >
                    <div className="self-center text-[13px]">{phase}</div>
                    <select
                      className={inputClass}
                      value={override.tool}
                      onChange={(e) =>
                        updateSection('orchestrator', {
                          ...draft.orchestrator,
                          phases: {
                            ...draft.orchestrator.phases,
                            [phase]: { tool: e.target.value, model: '' },
                          },
                        })
                      }
                    >
                      <option value="">Select tool</option>
                      {toolOptions.map((tool) => (
                        <option key={tool} value={tool}>
                          {tool}
                        </option>
                      ))}
                    </select>
                    <select
                      className={inputClass}
                      value={override.model}
                      onChange={(e) =>
                        updateSection('orchestrator', {
                          ...draft.orchestrator,
                          phases: {
                            ...draft.orchestrator.phases,
                            [phase]: { ...override, model: e.target.value },
                          },
                        })
                      }
                    >
                      <option value="">Select model</option>
                      {phaseModels.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.id}
                        </option>
                      ))}
                    </select>
                  </div>
                )
              },
            )}
          </div>
        </SectionCard>

        <SectionCard
          title="Monitor"
          id="monitor"
          saving={saving.monitor}
          error={errors.monitor}
          onSave={() => savePatch('monitor', { monitor: draft.monitor })}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <LabeledInput
              label="Stuck check interval"
              value={draft.monitor.stuck_check_interval}
              onChange={(value) =>
                updateSection('monitor', {
                  ...draft.monitor,
                  stuck_check_interval: value,
                })
              }
            />
            <LabeledInput
              label="Max stuck cycles"
              type="number"
              value={String(draft.monitor.max_stuck_cycles)}
              onChange={(value) =>
                updateSection('monitor', {
                  ...draft.monitor,
                  max_stuck_cycles: Number(value) || 0,
                })
              }
            />
            <LabeledInput
              label="Conflict check interval"
              value={draft.monitor.conflict_check_interval}
              onChange={(value) =>
                updateSection('monitor', {
                  ...draft.monitor,
                  conflict_check_interval: value,
                })
              }
            />
          </div>
        </SectionCard>

        <SectionCard
          title="Quality"
          id="quality"
          saving={saving.quality}
          error={errors.quality}
          onSave={() => savePatch('quality', { quality: draft.quality })}
        >
          <Toggle
            label="Enabled"
            checked={draft.quality.enabled}
            onChange={(checked) =>
              updateSection('quality', { ...draft.quality, enabled: checked })
            }
          />
          <Toggle
            label="Scope check"
            checked={draft.quality.scope_check}
            onChange={(checked) =>
              updateSection('quality', {
                ...draft.quality,
                scope_check: checked,
              })
            }
          />
          <Toggle
            label="Test delta"
            checked={draft.quality.test_delta}
            onChange={(checked) =>
              updateSection('quality', {
                ...draft.quality,
                test_delta: checked,
              })
            }
          />
        </SectionCard>

        <SectionCard
          title="Logging"
          id="logging"
          saving={saving.logging}
          error={errors.logging}
          onSave={() => savePatch('logging', { logging: draft.logging })}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1 text-xs">
              Level
              <select
                className={inputClass}
                value={draft.logging.level}
                onChange={(e) =>
                  updateSection('logging', {
                    ...draft.logging,
                    level: e.target.value,
                  })
                }
              >
                {['debug', 'info', 'warn', 'error'].map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </label>
            <LabeledInput
              label="File"
              value={draft.logging.file}
              onChange={(value) =>
                updateSection('logging', { ...draft.logging, file: value })
              }
            />
            <LabeledInput
              label="Max size"
              value={draft.logging.max_size}
              onChange={(value) =>
                updateSection('logging', { ...draft.logging, max_size: value })
              }
            />
          </div>
        </SectionCard>
      </div>
    </div>
  )
}

function SectionCard({
  title,
  id,
  saving,
  error,
  onSave,
  children,
}: SectionCardProps) {
  return (
    <details className={sectionClass} open>
      <summary className="cursor-pointer list-none border-b px-4 py-3 text-sm font-semibold">
        {title}
      </summary>
      <div className="space-y-3 p-4">
        {children}
        <div className="flex items-center justify-end gap-3 pt-1">
          {error ? <span className="text-xs text-danger">{error}</span> : null}
          <button
            type="button"
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
            onClick={onSave}
            disabled={saving}
            data-section={id}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </details>
  )
}

function LabeledInput({
  label,
  value,
  onChange,
  type = 'text',
}: LabeledInputProps) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      {label}
      <input
        className={inputClass}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}

function Toggle({ label, checked, onChange }: ToggleProps) {
  return (
    <label className="flex items-center gap-2 text-[13px]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  )
}

export const Route = createFileRoute('/config')({
  component: ConfigPage,
})
