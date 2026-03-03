import { useEffect, useRef } from 'react'

interface Props {
  content: string
  placeholder?: string
  className?: string
}

export function LogViewer({
  content,
  placeholder = 'No output yet.',
  className,
}: Props) {
  const bodyRef = useRef<HTMLPreElement | null>(null)

  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [content])

  return (
    <pre
      ref={bodyRef}
      className={[
        'h-full overflow-auto rounded-lg bg-background p-4 font-mono text-xs leading-relaxed text-foreground whitespace-pre-wrap',
        className ?? '',
      ].join(' ')}
    >
      {content || placeholder}
    </pre>
  )
}
