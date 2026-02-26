import { useQuery } from '@tanstack/react-query'
import { api } from '../../api'
import { queryKeys } from '../../lib/queryKeys'

export function useModelsQuery(tool?: string) {
  return useQuery({
    queryKey: queryKeys.models(tool),
    queryFn: () => api.listModels(tool),
  })
}
