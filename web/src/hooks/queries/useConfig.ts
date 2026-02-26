import { useQuery } from '@tanstack/react-query'
import { api } from '../../api'
import { queryKeys } from '../../lib/queryKeys'

export function useConfigQuery() {
  return useQuery({ queryKey: queryKeys.config, queryFn: api.getConfig })
}
