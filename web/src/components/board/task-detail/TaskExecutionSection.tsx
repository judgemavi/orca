import { DiffViewer } from '../../blocks/DiffViewer'
import { ActionButton } from '../../common/ActionButton'
import type { Artifact, Task } from '../../../types'

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '-'
  if (durationMs < 1000) return `${durationMs} ms`
  return `${(durationMs / 1000).toFixed(2)} s`
}

interface Props {
  task: Task
  artifacts: Artifact[]
  logs: string[]
  logsLoading: boolean
  artifactsLoading: boolean
  readOnly?: boolean
  onRefresh: () => void
}

export function TaskExecutionSection({
  task,
  artifacts,
  logs,
  logsLoading,
  artifactsLoading,
  readOnly = false,
  onRefresh,
}: Props) {
  const latestArtifact = artifacts[0] ?? null
  const shouldShowLogs = task.status === 'running'
  const refreshDisabled = readOnly || logsLoading || artifactsLoading

  return (
    <div className="flex flex-col gap-2.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-[var(--text-secondary)]">Execution</span>
        <ActionButton variant="default" onClick={onRefresh} disabled={refreshDisabled}>
          Refresh
        </ActionButton>
      </div>

      {shouldShowLogs && (
        <div className="flex flex-col gap-1.5">
          <div className="text-xs text-[var(--text-secondary)]">
            Live output {logsLoading ? '(loading...)' : ''}
          </div>
          <pre className="max-h-[220px] overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-2 font-mono text-[11px] text-[var(--text-primary)]">
            {logs.length > 0 ? logs.join('\n') : 'No output yet.'}
          </pre>
        </div>
      )}

      {!shouldShowLogs && artifactsLoading && (
        <div className="text-xs text-[var(--text-secondary)]">Loading artifacts...</div>
      )}

      {!shouldShowLogs && !artifactsLoading && !latestArtifact && (
        <div className="text-xs text-[var(--text-secondary)]">
          No artifacts found for this task yet.
        </div>
      )}

      {!shouldShowLogs && latestArtifact && (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2 text-xs text-[var(--text-secondary)] sm:grid-cols-4">
            <div>
              <span className="block text-[10px] uppercase">Exit code</span>
              <span className="font-mono text-[var(--text-primary)]">
                {latestArtifact.exit_code}
              </span>
            </div>
            <div>
              <span className="block text-[10px] uppercase">Duration</span>
              <span className="font-mono text-[var(--text-primary)]">
                {formatDuration(latestArtifact.duration_ms)}
              </span>
            </div>
            <div className="col-span-2">
              <span className="block text-[10px] uppercase">Captured at</span>
              <span className="font-mono text-[var(--text-primary)]">
                {new Date(latestArtifact.created_at).toLocaleString()}
              </span>
            </div>
          </div>

          {latestArtifact.diff ? (
            <DiffViewer
              data={{
                task_id: task.id,
                title: task.title,
                diff: latestArtifact.diff,
                files_changed: [],
                actions: [],
              }}
            />
          ) : (
            <div className="text-xs text-[var(--text-secondary)]">No diff captured.</div>
          )}

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="text-xs text-[var(--text-secondary)]">stdout</div>
              <pre className="max-h-[180px] overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-2 font-mono text-[11px] text-[var(--text-primary)]">
                {latestArtifact.stdout || '(empty)'}
              </pre>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="text-xs text-[var(--text-secondary)]">stderr</div>
              <pre className="max-h-[180px] overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-2 font-mono text-[11px] text-[var(--status-failed)]">
                {latestArtifact.stderr || '(empty)'}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
