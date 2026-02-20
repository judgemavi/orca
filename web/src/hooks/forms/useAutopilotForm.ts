import { useForm } from '@tanstack/react-form'

export interface AutopilotFormValues {
  goal: string
  maxSprints: number
  unattended: boolean
}

export const autopilotFormDefaults: AutopilotFormValues = {
  goal: '',
  maxSprints: 5,
  unattended: false,
}

function validate(values: AutopilotFormValues) {
  const errors: Partial<Record<keyof AutopilotFormValues, string>> = {}
  if (values.goal.trim().length < 1) {
    errors.goal = 'Goal is required'
  }
  if (values.maxSprints < 1) {
    errors.maxSprints = 'Max sprints must be at least 1'
  }
  return Object.keys(errors).length > 0 ? errors : undefined
}

export function useAutopilotForm(initial?: Partial<AutopilotFormValues>) {
  return useForm({
    defaultValues: { ...autopilotFormDefaults, ...initial },
    validators: {
      onChange: ({ value }) => validate(value),
      onSubmit: ({ value }) => validate(value),
    },
    onSubmit: async () => {
      // Submit handler will be wired by consuming components in migration layer.
    },
  })
}
