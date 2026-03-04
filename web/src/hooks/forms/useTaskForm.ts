import { useForm } from '@tanstack/react-form';

interface TaskFormValues {
  title: string;
  description: string;
}

const taskFormDefaults: TaskFormValues = {
  title: '',
  description: '',
};

function validate(values: TaskFormValues) {
  const errors: Partial<Record<keyof TaskFormValues, string>> = {};
  if (values.title.trim().length < 1) {
    errors.title = 'Title is required';
  }
  return Object.keys(errors).length > 0 ? errors : undefined;
}

export function useTaskForm(
  initial?: Partial<TaskFormValues>,
  onSubmitValue?: (values: TaskFormValues) => Promise<void> | void,
) {
  return useForm({
    defaultValues: { ...taskFormDefaults, ...initial },
    validators: {
      onChange: ({ value }) => validate(value),
      onSubmit: ({ value }) => validate(value),
    },
    onSubmit: async ({ value }) => {
      await onSubmitValue?.(value);
    },
  });
}
