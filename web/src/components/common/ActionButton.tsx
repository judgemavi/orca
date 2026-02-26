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
      'border-slate-700 bg-transparent hover:bg-slate-900',
    primary:
      'border-blue-500 text-blue-500 hover:bg-blue-500 hover:text-white',
    danger:
      'border-red-400 hover:bg-red-400 hover:text-white',
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
