import { useForm } from '@tanstack/react-form'

interface CreateTaskFormValues {
  title: string
  description: string
  dependencies: string[]
}

const createTaskFormDefaults: CreateTaskFormValues = {
  title: '',
  description: '',
  dependencies: [],
}

function validate(values: CreateTaskFormValues) {
  const errors: Partial<Record<keyof CreateTaskFormValues, string>> = {}
  if (values.title.trim().length < 1) {
    errors.title = 'Title is required'
  }
  return Object.keys(errors).length > 0 ? errors : undefined
}

export function useCreateTaskForm(
  initial?: Partial<CreateTaskFormValues>,
  onSubmitValue?: (values: CreateTaskFormValues) => Promise<void> | void,
) {
  return useForm({
    defaultValues: { ...createTaskFormDefaults, ...initial },
    validators: {
      onChange: ({ value }) => validate(value),
      onSubmit: ({ value }) => validate(value),
    },
    onSubmit: async ({ value }) => {
      await onSubmitValue?.(value)
    },
  })
}
