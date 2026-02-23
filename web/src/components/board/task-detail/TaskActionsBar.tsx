import type { useTaskForm } from '../../../hooks/forms/useTaskForm'
import type { ReviewArtifact, Task } from '../../../types'
import { ActionButton } from '../../common/ActionButton'

interface Props {
  task: Task
  artifact: ReviewArtifact | null
  isEditable: boolean
  isDeletable: boolean
  deleting: boolean
  saving: boolean
  merging: boolean
  conflictError: string | null
  form: ReturnType<typeof useTaskForm>
  onDelete: () => void
  onMerge: () => void
  onClose: () => void
}

export function TaskActionsBar({
  task,
  artifact,
  isEditable,
  isDeletable,
  deleting,
  saving,
  merging,
  conflictError,
  form,
  onDelete,
  onMerge,
  onClose,
}: Props) {
  return (
    <div className="flex items-center justify-between border-t border-[var(--border)] px-5 py-3">
      {isDeletable ? (
        <ActionButton variant="danger" onClick={onDelete} disabled={deleting}>
          {deleting ? 'Deleting…' : 'Delete'}
        </ActionButton>
      ) : (
        <div />
      )}
      <div className="flex gap-2">
        {task.status === 'approved' && artifact?.diff && (
          <ActionButton variant="primary" onClick={onMerge} disabled={merging}>
            {merging ? 'Merging…' : conflictError ? 'Retry Merge' : 'Merge'}
          </ActionButton>
        )}
        <ActionButton variant="default" onClick={onClose} type="button">
          Close
        </ActionButton>
        {isEditable && (
          <form.Subscribe selector={(state) => state.isDirty}>
            {(isDirty) => (
              <ActionButton variant="primary" type="submit" disabled={saving || !isDirty}>
                {saving ? 'Saving…' : 'Save'}
              </ActionButton>
            )}
          </form.Subscribe>
        )}
      </div>
    </div>
  )
}
