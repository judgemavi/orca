import { ActionButton } from '../../common/ActionButton'

interface Props {
  mergeProgress: string | null
  conflictError: string | null
  merging: boolean
  showManualResolve: boolean
  conflictWorktreePath: string
  onAutoResolve: () => void
  onShowManualResolve: () => void
}

export function TaskMergeStatus({
  mergeProgress,
  conflictError,
  merging,
  showManualResolve,
  conflictWorktreePath,
  onAutoResolve,
  onShowManualResolve,
}: Props) {
  return (
    <>
      {mergeProgress && (
        <div className="flex flex-col gap-2 rounded-md border border-[#e0b4b4] bg-[#fff5f5] p-3">
          <div className="text-xs leading-5 text-[#8a1f1f]">
            {mergeProgress}
          </div>
        </div>
      )}

      {conflictError && !mergeProgress && (
        <div className="flex flex-col gap-2 rounded-md border border-[#e0b4b4] bg-[#fff5f5] p-3">
          <div className="text-xs leading-5 text-[#8a1f1f]">
            Merge conflict: {conflictError}
          </div>
          <div className="flex gap-2">
            <ActionButton
              variant="primary"
              onClick={onAutoResolve}
              disabled={merging}
            >
              Auto-resolve
            </ActionButton>
            <ActionButton
              variant="default"
              onClick={onShowManualResolve}
            >
              Manual resolve
            </ActionButton>
          </div>
          {showManualResolve && (
            <div className="flex flex-col gap-1.5 text-xs text-[var(--text-secondary)]">
              {conflictWorktreePath && (
                <div className="font-mono text-[11px] text-[var(--text-primary)]">
                  Worktree: <code>{conflictWorktreePath}</code>
                </div>
              )}
              <div>
                Resolve conflicts in the worktree, commit the fixes, then
                click Retry Merge.
              </div>
            </div>
          )}
        </div>
      )}
    </>
  )
}
