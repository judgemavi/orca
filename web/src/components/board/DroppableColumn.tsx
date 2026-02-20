import { useDroppable } from '@dnd-kit/core'

interface Props {
  id: string
  children: React.ReactNode
  className?: string
  activeDrag?: boolean
  canDrop?: boolean
}

export function DroppableColumn({
  id,
  children,
  className,
  activeDrag = false,
  canDrop = true,
}: Props) {
  const { setNodeRef, isOver } = useDroppable({ id })

  return (
    <div
      ref={setNodeRef}
      className={[
        className,
        'transition-[border-color,background-color,opacity] duration-150 ease-in-out',
        activeDrag && canDrop ? 'border-blue-400/45' : '',
        activeDrag && !canDrop ? 'opacity-50' : '',
        isOver && canDrop ? 'border-accent bg-blue-500/5' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </div>
  )
}
