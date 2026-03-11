import { createContext, type ReactNode, useContext } from 'react';
import type { Config, Task } from '../types';

type TaskDetailContextValue = {
  task: Task;
  config: Config;
  tools: string[];
  isOperationRunning: (type: string, targetId?: string) => boolean;
};

const TaskDetailContext = createContext<TaskDetailContextValue | null>(null);

type TaskDetailProviderProps = {
  children: ReactNode;
  task: Task;
  config: Config;
  tools: string[];
  isOperationRunning: (type: string, targetId?: string) => boolean;
};

export function TaskDetailProvider({
  children,
  task,
  config,
  tools,
  isOperationRunning,
}: TaskDetailProviderProps) {
  return (
    <TaskDetailContext.Provider
      value={{
        task,
        config,
        tools,
        isOperationRunning,
      }}
    >
      {children}
    </TaskDetailContext.Provider>
  );
}

export function useTaskDetailContext() {
  const context = useContext(TaskDetailContext);
  if (!context) {
    throw new Error(
      'useTaskDetailContext must be used within TaskDetailProvider',
    );
  }
  return context;
}
