interface Props {
  label?: string
  children?: React.ReactNode
  onClick?: () => void
  variant?: 'default' | 'primary' | 'danger'
  size?: 'default' | 'toolbar'
  disabled?: boolean
  type?: 'button' | 'submit' | 'reset'
  form?: string
}

export function ActionButton({
  label,
  children,
  onClick,
  variant = 'default',
  size = 'default',
  disabled = false,
  type = 'button',
  form,
}: Props) {
  const base =
    'inline-flex items-center rounded-lg border font-medium transition-colors'
  const sizes: Record<NonNullable<Props['size']>, string> = {
    default: 'px-3 py-1.5 text-sm',
    toolbar: 'px-3 py-1.5 text-xs',
  }
  const variants: Record<NonNullable<Props['variant']>, string> = {
    default:
      'border-border-subtle bg-transparent text-foreground hover:bg-surface-alt',
    primary: 'border-accent bg-accent text-white hover:bg-accent/90',
    danger: 'border-danger bg-danger text-white hover:bg-danger/90',
  }
  return (
    <button
      className={`${base} ${sizes[size]} ${variants[variant]} ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
      onClick={onClick}
      disabled={disabled}
      type={type}
      form={form}
    >
      {children ?? label}
    </button>
  )
}
