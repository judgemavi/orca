import { Slot } from '@radix-ui/react-slot';
import clsx from 'clsx';

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'destructive';
  size?: 'default' | 'icon';
  asChild?: boolean;
}

export function Button({
  variant = 'default',
  size = 'default',
  type = 'button',
  asChild = false,
  className,
  ...props
}: Props) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      className={clsx(
        'inline-flex items-center rounded-lg border font-medium transition-colors px-3 py-1.5 text-sm hover:cursor-pointer disabled:cursor-not-allowed disabled:opacity-50',
        {
          'border-border-subtle bg-transparent text-foreground hover:bg-surface-alt':
            variant === 'default',
          'border-accent bg-accent text-white hover:bg-accent/90':
            variant === 'primary',
          'border-danger bg-danger text-white hover:bg-danger/90':
            variant === 'destructive',
          'rounded-full p-1.5': size === 'icon',
        },
        className,
      )}
      type={type}
      {...props}
    />
  );
}
