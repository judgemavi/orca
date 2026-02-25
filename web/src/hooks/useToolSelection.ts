import { useState } from 'react'
import type { ModelInfo } from '../types'
import { useModelsQuery } from './queries/useModels'

export interface ToolSelection {
  tool: string
  model: string
  models: Array<{ id: string; name: string }>
  modelsFetching: boolean
  setTool: (tool: string) => void
  setModel: (model: string) => void
  /** Sets tool and clears model (common pattern when tool changes) */
  changeTool: (tool: string) => void
  reset: () => void
}

export function useToolSelection(initialTool?: string): ToolSelection {
  const [tool, setTool] = useState(initialTool ?? '')
  const [model, setModel] = useState('')

  const modelsQuery = useModelsQuery(tool || undefined)
  const models: ModelInfo[] = tool ? (modelsQuery.data?.[tool] ?? []) : []

  const changeTool = (nextTool: string) => {
    setTool(nextTool)
    setModel('')
  }

  const reset = () => {
    setTool('')
    setModel('')
  }

  return {
    tool,
    model,
    models,
    modelsFetching: modelsQuery.isFetching,
    setTool,
    setModel,
    changeTool,
    reset,
  }
}
