import { createContext, useContext } from 'react'
import type { WSEvent } from '../types'

export const WSContext = createContext<WSEvent | null>(null)

export function useLastWSEvent() {
  return useContext(WSContext)
}
