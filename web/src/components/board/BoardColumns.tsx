import {
  DndContext,
  DragOverlay,
  closestCenter,
  type DragEndEvent,
  type DragStartEvent,
  type SensorDescriptor,
  type SensorOptions,
} from '@dnd-kit/core'
import type { Task } from '../../types'
import { BoardTaskCard } from './BoardTaskCard'
import { DraggableTaskCard } from './DraggableTaskCard'
import { BoardColumn } from './BoardColumn'

export type ColumnDef =
  | { kind: 'single'; id: Task['status']; label: string }
  | { kind: 'grouped'; id: string; label: string; sections: { id: Task['status']; label: string }[] }

export const COLUMNS: ColumnDef[] = [
  { kind: 'single', id: 'pending', label: 'Backlog' },
  { kind: 'single', id: 'in_sprint', label: 'In Sprint' },
  { kind: 'single', id: 'running', label: 'Running' },
  { kind: 'grouped', id: 'outcome', label: 'Outcome', sections: [
    { id: 'review', label: 'Review' },
    { id: 'failed', label: 'Failed' },
  ]},
  { kind: 'single', id: 'approved', label: 'Approved' },
  { kind: 'single', id: 'merged', label: 'Merged' },
]

// Flat list of all status IDs used for drag/drop and filtering.
export const ALL_STATUS_IDS: Task['status'][] = COLUMNS.flatMap((col) =>
  col.kind === 'grouped' ? col.sections.map((s) => s.id) : [col.id as Task['status']],
)

interface DraggableTaskCardWithModelsProps {
  task: Task
  onClick: () => void
  onRefresh: () => void
}

function DraggableTaskCardWithModels({
  task,
  onClick,
  onRefresh,
}: DraggableTaskCardWithModelsProps) {
  return (
    <DraggableTaskCard
      task={task}
      onClick={onClick}
      onRefresh={onRefresh}
    />
  )
}

interface DragOverlayTaskCardProps {
  task: Task
}

function DragOverlayTaskCard({ task }: DragOverlayTaskCardProps) {
  return <BoardTaskCard task={task} interactive={false} />
}

interface BoardColumnsProps {
  tasksByStatus: Record<string, Task[]>
  activeTask: Task | null
  canDropTaskToColumn: (task: Task, col: string) => boolean
  sensors: SensorDescriptor<SensorOptions>[]
  onDragStart: (event: DragStartEvent) => void
  onDragEnd: (event: DragEndEvent) => void
  onCreateTask: () => void
  onSelectTask: (taskId: string) => void
  refreshAfterTaskUpdate: () => void
}

export function BoardColumns({
  tasksByStatus,
  activeTask,
  canDropTaskToColumn,
  sensors,
  onDragStart,
  onDragEnd,
  onCreateTask,
  onSelectTask,
  refreshAfterTaskUpdate,
}: BoardColumnsProps) {
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div className="flex flex-1 gap-0 overflow-x-auto overflow-y-hidden">
        {COLUMNS.map((col) =>
          col.kind === 'single' ? (
            <BoardColumn
              key={col.id}
              id={col.id as Task['status']}
              label={col.label}
              tasks={tasksByStatus[col.id] ?? []}
              activeTask={activeTask}
              canDrop={activeTask ? canDropTaskToColumn(activeTask, col.id) : true}
              onCreateTask={onCreateTask}
              renderTask={(task) => (
                <DraggableTaskCardWithModels
                  key={task.id}
                  task={task}
                  onClick={() => onSelectTask(task.id)}
                  onRefresh={refreshAfterTaskUpdate}
                />
              )}
            />
          ) : (
            <div
              key={col.id}
              className="flex min-w-[200px] flex-1 flex-col overflow-hidden border-r border-border last:border-r-0"
            >
              {col.sections.map((section) => (
                <BoardColumn
                  key={section.id}
                  id={section.id}
                  label={section.label}
                  tasks={tasksByStatus[section.id] ?? []}
                  activeTask={activeTask}
                  canDrop={activeTask ? canDropTaskToColumn(activeTask, section.id) : true}
                  onCreateTask={onCreateTask}
                  grouped
                  renderTask={(task) => (
                    <DraggableTaskCardWithModels
                      key={task.id}
                      task={task}
                      onClick={() => onSelectTask(task.id)}
                      onRefresh={refreshAfterTaskUpdate}
                    />
                  )}
                />
              ))}
            </div>
          ),
        )}
      </div>

      <DragOverlay>
        {activeTask ? (
          <div className="w-[min(360px,calc(100vw-24px))]">
            <DragOverlayTaskCard task={activeTask} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
