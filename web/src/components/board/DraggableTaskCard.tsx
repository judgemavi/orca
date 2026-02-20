import { useDraggable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import type { Task, ModelInfo } from '../../types'
import { BoardTaskCard } from './BoardTaskCard'

interface Props {
  task: Task
  tools: string[]
  models: ModelInfo[]
  loadingModels?: boolean
  onClick: () => void
  onRefresh: () => void
}

export function DraggableTaskCard({
  task,
  tools,
  models,
  loadingModels,
  onClick,
  onRefresh,
}: Props) {
  const draggable =
    task.status !== 'completed' &&
    task.status !== 'merged' &&
    task.status !== 'running'

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
        tools={tools}
        models={models}
        loadingModels={loadingModels}
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
