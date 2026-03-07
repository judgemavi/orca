import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { queryKeys } from '../lib/queryKeys';
import { useTasksQuery } from './queries';

export function useDependencyManager(taskId: string, currentDeps: string[]) {
  const tasksQuery = useTasksQuery();
  const queryClient = useQueryClient();
  const [selectedDependencyId, setSelectedDependencyId] = useState('');
  const [dependencyError, setDependencyError] = useState<string | null>(null);

  const addDependencyMutation = useMutation({
    mutationFn: (dependencyId: string) =>
      api.updateTask(taskId, { dependsOn: [...currentDeps, dependencyId] }),
    onSuccess: async () => {
      setSelectedDependencyId('');
      await queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
    },
    onError: (err) => {
      setDependencyError(err?.message ?? 'Failed to add dependency');
    },
  });

  const dependencyChoices = useMemo(
    () =>
      (tasksQuery.data ?? [])
        .filter(
          (candidate) =>
            candidate.id !== taskId && !currentDeps.includes(candidate.id),
        )
        .sort((a, b) => a.title.localeCompare(b.title)),
    [currentDeps, taskId, tasksQuery.data],
  );

  useEffect(() => {
    setSelectedDependencyId('');
    setDependencyError(null);
  }, [taskId]);

  const handleAddDependency = async () => {
    if (!selectedDependencyId) {
      setDependencyError('Select a task to add as a dependency.');
      return;
    }

    setDependencyError(null);
    await addDependencyMutation.mutateAsync(selectedDependencyId);
  };

  return {
    dependencyChoices,
    selectedDependencyId,
    setSelectedDependencyId,
    addingDependency: addDependencyMutation.isPending,
    dependencyError,
    clearDependencyError: () => setDependencyError(null),
    handleAddDependency,
  };
}
