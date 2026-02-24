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
      'border-[var(--border)] bg-transparent text-[var(--text-primary)] hover:bg-[var(--bg-sidebar)]',
    primary:
      'border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-white',
    danger:
      'border-[var(--status-failed)] text-[var(--status-failed)] hover:bg-[var(--status-failed)] hover:text-white',
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
