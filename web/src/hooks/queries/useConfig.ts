import { useQuery } from '@tanstack/react-query'
import { api } from '../../api'

export function useConfigQuery() {
  return useQuery({ queryKey: ['config'], queryFn: api.getConfig })
}
