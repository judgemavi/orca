import { useQuery } from '@tanstack/react-query'
import { api } from '../../api'

export const modelsKeys = {
  byTool: (tool?: string) => ['models', tool ?? null] as const,
}

export function useModelsQuery(tool?: string) {
  return useQuery({
    queryKey: modelsKeys.byTool(tool),
    queryFn: () => api.listModels(tool),
  })
}
