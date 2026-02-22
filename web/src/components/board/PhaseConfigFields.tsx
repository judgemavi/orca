import { useMemo } from 'react'
import type { Config } from '../../types'
import { useModelsQuery } from '../../hooks/queries/useModels'

const PHASES = ['plan', 'sprint', 'review'] as const

type PhaseName = (typeof PHASES)[number]

type PhaseValues = Record<string, { tool: string; model: string }>

interface Props {
  tools: string[]
  config: Config
  phases: PhaseValues
  onChange: (phases: PhaseValues) => void
  controlClass: string
}

interface PhaseRowProps {
  phase: PhaseName
  value: { tool: string; model: string }
  tools: string[]
  config: Config
  controlClass: string
  onToolChange: (tool: string) => void
  onModelChange: (model: string) => void
}

function phaseLabel(phase: PhaseName) {
  return phase[0].toUpperCase() + phase.slice(1)
}

function PhaseRow({
  phase,
  value,
  tools,
  config,
  controlClass,
  onToolChange,
  onModelChange,
}: PhaseRowProps) {
  const _modelsQuery = useModelsQuery(value.tool || undefined)
  void _modelsQuery.data
  const configuredModels = value.tool ? (config.tools[value.tool]?.models ?? []) : []

  const staleTool = Boolean(value.tool) && !tools.includes(value.tool)
  const staleModel =
    Boolean(value.model) &&
    (!value.tool || !configuredModels.includes(value.model))

  const modelOptions = useMemo(() => {
    if (!value.tool) return []
    const unique = new Set<string>()
    const models: string[] = []
    for (const model of configuredModels) {
      if (!model || unique.has(model)) continue
      unique.add(model)
      models.push(model)
    }
    return models
  }, [configuredModels, value.tool])

  return (
    <tr className="border-b border-[var(--border)] last:border-b-0">
      <td className="px-2 py-2 text-xs font-medium text-[var(--text-primary)]">
        {phaseLabel(phase)}
      </td>
      <td className="px-2 py-2 align-top">
        <select
          className={controlClass}
          value={value.tool}
          onChange={(e) => onToolChange(e.target.value)}
        >
          <option value="">- inherit default</option>
          {tools.map((tool) => (
            <option key={tool} value={tool}>
              {tool}
            </option>
          ))}
          {staleTool && (
            <option value={value.tool}>{value.tool} (unavailable)</option>
          )}
        </select>
        {staleTool && (
          <p className="mt-1 text-[11px] text-[var(--status-failed)]">
            Tool is not available in current config.
          </p>
        )}
      </td>
      <td className="px-2 py-2 align-top">
        <select
          className={controlClass}
          value={value.model}
          onChange={(e) => onModelChange(e.target.value)}
          disabled={!value.tool}
        >
          <option value="">- inherit default</option>
          {modelOptions.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
          {staleModel && (
            <option value={value.model}>{value.model} (unavailable)</option>
          )}
        </select>
        {staleModel && (
          <p className="mt-1 text-[11px] text-[var(--status-failed)]">
            Model is not available for selected tool.
          </p>
        )}
      </td>
    </tr>
  )
}

export function PhaseConfigFields({
  tools,
  config,
  phases,
  onChange,
  controlClass,
}: Props) {
  return (
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
            const row = phases[phase] ?? { tool: '', model: '' }
            return (
              <PhaseRow
                key={phase}
                phase={phase}
                value={row}
                tools={tools}
                config={config}
                controlClass={controlClass}
                onToolChange={(tool) => {
                  onChange({
                    ...phases,
                    [phase]: {
                      tool,
                      model: tool ? row.model : '',
                    },
                  })
                }}
                onModelChange={(model) => {
                  onChange({
                    ...phases,
                    [phase]: {
                      ...row,
                      model,
                    },
                  })
                }}
              />
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
