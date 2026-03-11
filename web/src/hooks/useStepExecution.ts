import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { queryKeys } from '../lib/queryKeys';
import { getErrorMessage } from '../lib/utils';

type StepExecutionOptions = {
  taskId: string;
  currentStep?: string | null;
  tool?: string;
  model?: string;
};

export function useStepExecution({
  taskId,
  currentStep,
  tool,
  model,
}: StepExecutionOptions) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks }),
      queryClient.invalidateQueries({ queryKey: queryKeys.task(taskId) }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.taskInteractions(taskId),
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.currentStep(taskId, currentStep ?? undefined),
      }),
    ]);
  };

  const runStepMutation = useMutation({
    mutationFn: () =>
      api.runStep(taskId, {
        tool: tool || undefined,
        model: model || undefined,
      }),
    onSuccess: async () => {
      setError(null);
      await invalidate();
    },
    onError: (err: unknown) => {
      setError(getErrorMessage(err, 'Failed to run step'));
    },
  });

  const manualStepMutation = useMutation({
    mutationFn: (output: string) => api.manualStep(taskId, { output }),
    onSuccess: async () => {
      setError(null);
      await invalidate();
    },
    onError: (err: unknown) => {
      setError(getErrorMessage(err, 'Failed to save manual step'));
    },
  });

  const completeStepMutation = useMutation({
    mutationFn: ({
      outcome,
      data,
      output,
    }: {
      outcome: string;
      data?: Record<string, string>;
      output?: string;
    }) =>
      api.completeStep(taskId, {
        outcome,
        ...(output ? { output } : {}),
        ...(data ? { data } : {}),
      }),
    onSuccess: async () => {
      setError(null);
      await invalidate();
    },
    onError: (err: unknown) => {
      setError(getErrorMessage(err, 'Failed to complete step'));
    },
  });

  return {
    error,
    setError,
    runStepMutation,
    manualStepMutation,
    completeStepMutation,
    invalidate,
  };
}
