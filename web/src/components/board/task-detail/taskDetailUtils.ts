import type { Config, Task } from '../../../types'

export type PhaseValues = Record<
  'plan' | 'sprint' | 'review',
  { tool: string; model: string }
>

export function buildDefaultPhaseValues(config: Config): PhaseValues {
  const tool = config.defaults?.tool ?? ''
  const model = config.defaults?.model ?? ''
  return {
    plan: { tool, model },
    sprint: { tool, model },
    review: { tool, model },
  }
}

export function buildTaskPhaseValues(task: Task, config: Config): PhaseValues {
  if (task.phase_config?.phases) {
    const defaults = buildDefaultPhaseValues(config)
    return {
      plan: {
        tool: task.phase_config.phases.plan?.tool ?? defaults.plan.tool,
        model: task.phase_config.phases.plan?.model ?? defaults.plan.model,
      },
      sprint: {
        tool: task.phase_config.phases.sprint?.tool ?? defaults.sprint.tool,
        model: task.phase_config.phases.sprint?.model ?? defaults.sprint.model,
      },
      review: {
        tool: task.phase_config.phases.review?.tool ?? defaults.review.tool,
        model: task.phase_config.phases.review?.model ?? defaults.review.model,
      },
    }
  }

  if (task.phase_config?.use_defaults) {
    return buildDefaultPhaseValues(config)
  }

  const legacyTool = task.assigned_tool ?? ''
  const legacyModel = task.model ?? ''
  return {
    plan: { tool: legacyTool, model: legacyModel },
    sprint: { tool: legacyTool, model: legacyModel },
    review: { tool: legacyTool, model: legacyModel },
  }
}

export function shouldUseDefaults(task: Task) {
  return task.phase_config?.use_defaults ?? true
}

export function toPhaseOverride(value: { tool: string; model: string }) {
  const patch: { tool?: string; model?: string } = {}
  if (value.tool) patch.tool = value.tool
  if (value.model) patch.model = value.model
  return patch
}
