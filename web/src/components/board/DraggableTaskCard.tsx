import { useDraggable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import type { Task } from '../../types'
import { BoardTaskCard } from './BoardTaskCard'

interface Props {
  task: Task
  onClick: () => void
  onRefresh: () => void
}

export function DraggableTaskCard({ task, onClick, onRefresh }: Props) {
  const draggable =
    task.status !== 'approved' &&
    task.status !== 'merged' &&
    task.status !== 'running' &&
    task.status !== 'review'

  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: task.id,
      disabled: !draggable,
    })

  return (
    <div
      ref={setNodeRef}
      className={[
        draggable ? 'touch-none' : 'touch-auto',
        isDragging ? 'opacity-45' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{
        transform: CSS.Transform.toString(transform),
      }}
      {...(draggable ? listeners : {})}
      {...(draggable ? attributes : {})}
    >
      <BoardTaskCard
        task={task}
        onClick={onClick}
        onRefresh={onRefresh}
        className={[
          draggable ? 'cursor-grab' : 'cursor-default',
          isDragging ? 'shadow-[0_10px_24px_rgba(15,23,42,0.22)]' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      />
    </div>
  )
}
