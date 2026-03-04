import { createContext, type ReactNode, useContext, useState } from 'react';
import type { Config, Task } from '../types';

type TaskDetailContextValue = {
  task: Task;
  config: Config;
  tools: string[];
  activeLogId: string | null;
  setActiveLogId: (id: string | null) => void;
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
  const [activeLogId, setActiveLogId] = useState<string | null>(null);

  return (
    <TaskDetailContext.Provider
      value={{
        task,
        config,
        tools,
        activeLogId,
        setActiveLogId,
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
