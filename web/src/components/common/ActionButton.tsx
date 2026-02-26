interface Props {
  label?: string
  children?: React.ReactNode
  onClick?: () => void
  variant?: 'default' | 'primary' | 'danger'
  disabled?: boolean
  type?: 'button' | 'submit' | 'reset'
  form?: string
}

export function ActionButton({
  label,
  children,
  onClick,
  variant = 'default',
  disabled = false,
  type = 'button',
  form,
}: Props) {
  const base =
    'inline-flex items-center rounded-md border px-3 py-1 text-[13px] font-medium transition-all duration-150'
  const variants: Record<NonNullable<Props['variant']>, string> = {
    default:
      'border-border bg-transparent hover:bg-surface-alt',
    primary:
      'border-accent text-accent hover:bg-accent hover:text-white',
    danger:
      'border-danger hover:bg-danger hover:text-white',
  }
  return (
    <button
      className={`${base} ${variants[variant]} ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
      onClick={onClick}
      disabled={disabled}
      type={type}
      form={form}
    >
      {children ?? label}
    </button>
  )
}
