import { createContext, useContext, useState, type ReactNode } from 'react'
import { useTaskDetail, type TaskDetailProps } from '../components/board/task-detail/useTaskDetail'
import type { Config, Task } from '../types'
import type { WSEvent } from '../types'

const controlClass =
  'w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2.5 py-2 text-[13px] text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]'

export type TaskDetailContextValue = ReturnType<typeof useTaskDetail> & {
  task: Task
  config: Config
  tools: string[]
  activeLogId: string | null
  setActiveLogId: (id: string | null) => void
  controlClass: string
}

export const TaskDetailContext = createContext<TaskDetailContextValue | null>(null)

type TaskDetailProviderProps = {
  children: ReactNode
  task: Task
  config: Config
  tools: string[]
  lastWSEvent?: WSEvent | null
  isOperationRunning: TaskDetailProps['isOperationRunning']
  onSaved: TaskDetailProps['onSaved']
  onDeleted: TaskDetailProps['onDeleted']
}

export function TaskDetailProvider({
  children,
  task,
  config,
  tools,
  lastWSEvent,
  isOperationRunning,
  onSaved,
  onDeleted,
}: TaskDetailProviderProps) {
  const taskDetail = useTaskDetail({
    task,
    tools,
    lastWSEvent,
    isOperationRunning,
    onSaved,
    onDeleted,
  })
  const [activeLogId, setActiveLogId] = useState<string | null>(null)

  return (
    <TaskDetailContext.Provider
      value={{
        ...taskDetail,
        task,
        config,
        tools,
        activeLogId,
        setActiveLogId,
        controlClass,
      }}
    >
      {children}
    </TaskDetailContext.Provider>
  )
}

export function useTaskDetailContext() {
  const context = useContext(TaskDetailContext)
  if (!context) {
    throw new Error('useTaskDetailContext must be used within TaskDetailProvider')
  }
  return context
}
