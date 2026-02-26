import type { useTaskForm } from '../../../hooks/forms/useTaskForm'
import { ActionButton } from '../../common/ActionButton'

interface Props {
  isEditable: boolean
  isDeletable: boolean
  deleting: boolean
  saving: boolean
  formId: string
  form: ReturnType<typeof useTaskForm>
  onDelete: () => void
  onClose: () => void
}

export function TaskActionsBar({
  isEditable,
  isDeletable,
  deleting,
  saving,
  formId,
  form,
  onDelete,
  onClose,
}: Props) {
  return (
    <div className="flex items-center justify-between border-t px-5 py-3">
      {isDeletable ? (
        <ActionButton variant="danger" onClick={onDelete} disabled={deleting}>
          {deleting ? 'Deleting…' : 'Delete'}
        </ActionButton>
      ) : (
        <div />
      )}
      <div className="flex gap-2">
        <ActionButton variant="default" onClick={onClose} type="button">
          Close
        </ActionButton>
        {isEditable && (
          <form.Subscribe selector={(state) => state.isDirty}>
            {(isDirty) => (
              <ActionButton
                variant="primary"
                type="submit"
                form={formId}
                disabled={saving || !isDirty}
              >
                {saving ? 'Saving…' : 'Save'}
              </ActionButton>
            )}
          </form.Subscribe>
        )}
      </div>
    </div>
  )
}
