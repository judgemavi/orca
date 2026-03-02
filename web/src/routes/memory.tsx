import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table'
import * as Dialog from '@radix-ui/react-dialog'
import { toast } from 'sonner'
import { api } from '../api'
import { Button } from '../components/Button'
import { DialogChrome } from '../components/DialogChrome'
import {
  useDeleteMemoryMutation,
  useMemoryEntryQuery,
  useMemoryMutation,
  useMemoryQuery,
  useMemorySemanticQuery,
  useRefreshMemoryMutation,
  useStatusQuery,
  useSyncMemoryMutation,
} from '../hooks/queries'
import { controlClass } from '../lib/constants'
import { queryKeys } from '../lib/queryKeys'
import type { MemoryCategory, MemoryEntry, MemorySourceType } from '../types'

const CATEGORIES: MemoryCategory[] = [
  'pattern',
  'pitfall',
  'preference',
  'convention',
  'architecture',
  'dependency',
]

const SOURCE_TYPES: MemorySourceType[] = [
  'retro',
  'explore',
]

const CATEGORY_TONE: Record<MemoryCategory, string> = {
  pattern: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  pitfall: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  preference: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  convention: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  architecture: 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300',
  dependency: 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300',
}

const SOURCE_TONE: Record<MemorySourceType, string> = {
  retro: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  explore: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
}

const columnHelper = createColumnHelper<MemoryEntry>()

type EditDraft = {
  content: string
  confidence: string
  category: MemoryCategory
}

function formatDate(iso: string) {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return '—'
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  })
}

function MemoryPage() {
  const [queryText, setQueryText] = useState('')
  const [category, setCategory] = useState<MemoryCategory | 'all'>('all')
  const [sourceType, setSourceType] = useState<MemorySourceType | 'all'>('all')
  const [filePath, setFilePath] = useState('')
  const [staleOnly, setStaleOnly] = useState(false)
  const [expandedContent, setExpandedContent] = useState<
    Record<string, boolean>
  >({})
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<EditDraft | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<MemoryEntry | null>(null)
  const queryClient = useQueryClient()

  const listParams = useMemo(() => {
    const filePathTrimmed = filePath.trim()
    return {
      ...(category !== 'all' ? { category } : {}),
      ...(sourceType !== 'all' ? { source_type: sourceType } : {}),
      ...(filePathTrimmed ? { file_path: filePathTrimmed } : {}),
      ...(staleOnly ? { stale: true } : {}),
    }
  }, [category, sourceType, filePath, staleOnly])

  const memoryQuery = useMemoryQuery(listParams)
  const semanticQuery = useMemorySemanticQuery(queryText.trim(), 20)
  const statusQuery = useStatusQuery()
  const updateMutation = useMemoryMutation()
  const deleteMutation = useDeleteMemoryMutation()
  const syncMutation = useSyncMemoryMutation()
  const refreshMutation = useRefreshMemoryMutation()
  const detailQuery = useMemoryEntryQuery(selectedEntryId ?? undefined)
  const exploreMutation = useMutation({
    mutationFn: () => api.runExplore(),
    onSuccess: async () => {
      toast.success('Explore started')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.operations() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.status }),
      ])
    },
    onError: (error: unknown) => {
      toast.error(
        error instanceof Error ? error.message : 'Failed to start explore',
      )
    },
  })

  const entries = useMemo(() => {
    if (queryText.trim()) {
      return (semanticQuery.data ?? []).map((item) => item.entry)
    }
    return memoryQuery.data ?? []
  }, [memoryQuery.data, queryText, semanticQuery.data])

  const allFilePaths = useMemo(() => {
    const set = new Set<string>()
    for (const entry of memoryQuery.data ?? []) {
      for (const path of entry.file_paths ?? []) {
        if (path) set.add(path)
      }
    }
    for (const item of semanticQuery.data ?? []) {
      for (const path of item.entry.file_paths ?? []) {
        if (path) set.add(path)
      }
    }
    return Array.from(set).sort()
  }, [memoryQuery.data, semanticQuery.data])

  const toggleExpanded = (id: string) => {
    setExpandedContent((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  const beginEdit = (entry: MemoryEntry) => {
    setEditingId(entry.id)
    setDraft({
      content: entry.content,
      confidence: String(entry.confidence),
      category: entry.category,
    })
  }

  const cancelEdit = () => {
    setEditingId(null)
    setDraft(null)
  }

  const saveEdit = async () => {
    if (!editingId || !draft) return

    const content = draft.content.trim()
    const confidence = Number(draft.confidence)
    if (!content) {
      toast.error('Content cannot be empty')
      return
    }
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      toast.error('Confidence must be between 0 and 1')
      return
    }

    try {
      await updateMutation.mutateAsync({
        id: editingId,
        data: {
          content,
          confidence,
          category: draft.category,
        },
      })
      toast.success('Memory updated')
      cancelEdit()
    } catch (error: unknown) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to update entry',
      )
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    try {
      await deleteMutation.mutateAsync(deleteTarget.id)
      if (editingId === deleteTarget.id) cancelEdit()
      toast.success('Memory deleted')
      setDeleteTarget(null)
    } catch (error: unknown) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to delete entry',
      )
    }
  }

  const columns = useMemo(
    () => [
      columnHelper.accessor('content', {
        header: 'Content',
        cell: ({ row, getValue }) => {
          const isEditing = editingId === row.original.id
          const content = getValue()
          const isExpanded = expandedContent[row.original.id] ?? false
          const showToggle = content.length > 140

          if (isEditing) {
            return (
              <textarea
                className={controlClass}
                value={draft?.content ?? ''}
                rows={4}
                onChange={(e) =>
                  setDraft((prev) =>
                    prev ? { ...prev, content: e.target.value } : prev,
                  )
                }
              />
            )
          }

          return (
            <div className="max-w-[560px]">
              <button
                type="button"
                className="text-left"
                onClick={() => setSelectedEntryId(row.original.id)}
              >
                <p
                  className={
                    isExpanded
                      ? 'whitespace-pre-wrap break-words text-sm'
                      : 'line-clamp-2 break-words text-sm'
                  }
                >
                  {content}
                </p>
              </button>
              {showToggle && (
                <button
                  type="button"
                  className="mt-1 text-xs text-muted hover:text-accent"
                  onClick={() => toggleExpanded(row.original.id)}
                >
                  {isExpanded ? 'Show less' : 'Show more'}
                </button>
              )}
            </div>
          )
        },
      }),
      columnHelper.accessor('stale', {
        header: 'Stale',
        cell: ({ getValue }) =>
          getValue() ? (
            <span className="inline-flex rounded bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
              Stale
            </span>
          ) : (
            <span className="text-xs text-muted">No</span>
          ),
      }),
      columnHelper.accessor('covered_at_commit', {
        header: 'Covered At',
        cell: ({ getValue }) => {
          const value = getValue()
          if (!value) {
            return <span className="text-xs text-muted">—</span>
          }
          const trimmed = value.trim()
          return (
            <span className="text-xs text-muted" title={trimmed}>
              {trimmed.slice(0, 8)}
            </span>
          )
        },
      }),
      columnHelper.accessor('category', {
        header: 'Category',
        cell: ({ row, getValue }) => {
          const isEditing = editingId === row.original.id
          if (isEditing) {
            return (
              <select
                className={controlClass}
                value={draft?.category ?? getValue()}
                onChange={(e) =>
                  setDraft((prev) =>
                    prev
                      ? {
                          ...prev,
                          category: e.target.value as MemoryCategory,
                        }
                      : prev,
                  )
                }
              >
                {CATEGORIES.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            )
          }

          const categoryValue = getValue()
          return (
            <span
              className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${CATEGORY_TONE[categoryValue]}`}
            >
              {categoryValue}
            </span>
          )
        },
      }),
      columnHelper.accessor('source_type', {
        header: 'Source Type',
        cell: ({ getValue }) => {
          const value = getValue()
          return (
            <span
              className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${SOURCE_TONE[value]}`}
            >
              {value}
            </span>
          )
        },
      }),
      columnHelper.accessor('tags', {
        header: 'Tags',
        cell: ({ getValue }) => {
          const tags = getValue()
          if (tags.length === 0) {
            return <span className="text-xs text-muted">—</span>
          }
          return (
            <div className="flex max-w-[220px] flex-wrap gap-1">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex rounded bg-surface-alt px-1.5 py-0.5 text-[11px]"
                >
                  {tag}
                </span>
              ))}
            </div>
          )
        },
      }),
      columnHelper.accessor('file_paths', {
        header: 'Files',
        cell: ({ getValue }) => {
          const paths = getValue() ?? []
          if (paths.length === 0) {
            return <span className="text-xs text-muted">—</span>
          }
          return (
            <div className="flex max-w-[260px] flex-wrap gap-1">
              {paths.map((path) => (
                <button
                  key={path}
                  type="button"
                  className="inline-flex rounded bg-surface-alt px-1.5 py-0.5 text-[11px] hover:bg-muted/50"
                  onClick={() => setFilePath(path)}
                  title={`Filter by ${path}`}
                >
                  {path}
                </button>
              ))}
            </div>
          )
        },
      }),
      columnHelper.accessor('confidence', {
        header: 'Confidence',
        cell: ({ row, getValue }) => {
          const isEditing = editingId === row.original.id
          if (isEditing) {
            return (
              <input
                className={controlClass}
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={draft?.confidence ?? String(getValue())}
                onChange={(e) =>
                  setDraft((prev) =>
                    prev ? { ...prev, confidence: e.target.value } : prev,
                  )
                }
              />
            )
          }

          const confidence = Math.max(0, Math.min(1, getValue()))
          return (
            <div className="flex min-w-[110px] items-center gap-2">
              <div className="h-1.5 w-16 rounded bg-surface-alt">
                <div
                  className="h-full rounded bg-accent"
                  style={{ width: `${Math.round(confidence * 100)}%` }}
                />
              </div>
              <span className="text-xs tabular-nums text-muted">
                {Math.round(confidence * 100)}%
              </span>
            </div>
          )
        },
      }),
      columnHelper.accessor('source_task_id', {
        header: 'Task',
        cell: ({ getValue }) => {
          const sourceTaskId = getValue()
          if (!sourceTaskId) {
            return <span className="text-xs text-muted">—</span>
          }
          return (
            <Link
              to="/$taskId"
              params={{ taskId: sourceTaskId }}
              className="text-xs font-medium"
            >
              {sourceTaskId.slice(0, 8)}
            </Link>
          )
        },
      }),
      columnHelper.accessor('created_at', {
        header: 'Created',
        cell: ({ getValue }) => (
          <span className="text-xs text-muted">{formatDate(getValue())}</span>
        ),
      }),
      columnHelper.display({
        id: 'actions',
        header: 'Actions',
        cell: ({ row }) => {
          const isEditing = editingId === row.original.id
          if (isEditing) {
            return (
              <div className="flex gap-1">
                <Button
                  variant="primary"
                  className="px-2 py-1 text-xs"
                  disabled={updateMutation.isPending}
                  onClick={() => void saveEdit()}
                >
                  {updateMutation.isPending ? 'Saving…' : 'Save'}
                </Button>
                <Button className="px-2 py-1 text-xs" onClick={cancelEdit}>
                  Cancel
                </Button>
              </div>
            )
          }

          return (
            <div className="flex gap-1">
              {row.original.stale ? (
                <Button
                  className="px-2 py-1 text-xs"
                  disabled={refreshMutation.isPending}
                  onClick={() =>
                    refreshMutation.mutate(row.original.id, {
                      onSuccess: () => toast.success('Entry refreshed'),
                      onError: (error) =>
                        toast.error(
                          error instanceof Error
                            ? error.message
                            : 'Refresh failed',
                        ),
                    })
                  }
                >
                  Refresh
                </Button>
              ) : null}
              <Button
                className="px-2 py-1 text-xs"
                onClick={() => beginEdit(row.original)}
              >
                Edit
              </Button>
              <Button
                variant="destructive"
                className="px-2 py-1 text-xs"
                onClick={() => setDeleteTarget(row.original)}
              >
                Delete
              </Button>
            </div>
          )
        },
      }),
    ],
    [
      draft,
      editingId,
      expandedContent,
      refreshMutation,
      updateMutation.isPending,
    ],
  )

  const table = useReactTable({
    data: entries,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })
  const hasSemanticQuery = queryText.trim().length > 0
  const listLoading = hasSemanticQuery
    ? semanticQuery.isLoading
    : memoryQuery.isLoading
  const listError = hasSemanticQuery ? semanticQuery.error : memoryQuery.error
  const listIsError = hasSemanticQuery
    ? semanticQuery.isError
    : memoryQuery.isError
  const status = statusQuery.data

  return (
    <div className="flex min-h-0 flex-1 flex-col py-4">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3">
        <h1 className="text-lg font-semibold">Memory</h1>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">
            {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
          </span>
          <Button
            variant="default"
            onClick={() => exploreMutation.mutate()}
            disabled={exploreMutation.isPending}
          >
            {exploreMutation.isPending ? 'Exploring…' : 'Explore'}
          </Button>
          <Button
            variant="default"
            onClick={() =>
              syncMutation.mutate(undefined, {
                onSuccess: (result) => {
                  const range =
                    result.last_commit && result.new_commit
                      ? `${result.last_commit.slice(0, 8)}→${result.new_commit.slice(0, 8)}`
                      : result.new_commit
                        ? `synced to ${result.new_commit.slice(0, 8)}`
                        : 'synced'
                  toast.success(
                    `Memory sync complete: ${result.flagged_entries} flagged, ${result.stale_entries} stale, ${result.superseded_count} superseded, ${result.affected_files.length} files, ${range}`,
                  )
                },
                onError: (error) => {
                  toast.error(
                    error instanceof Error
                      ? error.message
                      : 'Memory sync failed',
                  )
                },
              })
            }
            disabled={syncMutation.isPending}
          >
            {syncMutation.isPending ? 'Syncing…' : 'Sync'}
          </Button>
          {(status?.memory_stale_count ?? 0) > 0 ? (
            <Button
              variant="default"
              onClick={() =>
                refreshMutation.mutate(undefined, {
                  onSuccess: () =>
                    toast.success(
                      `Refreshed ${status?.memory_stale_count ?? 0} stale entries`,
                    ),
                  onError: (error) =>
                    toast.error(
                      error instanceof Error ? error.message : 'Refresh failed',
                    ),
                })
              }
              disabled={refreshMutation.isPending}
            >
              {refreshMutation.isPending ? 'Refreshing…' : 'Refresh All Stale'}
            </Button>
          ) : null}
        </div>
      </div>

      {status && (
        <div className="mb-3 space-y-2">
          <div
            className={`rounded-md border px-3 py-2 text-sm ${
              !status.last_synced_commit
                ? 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300'
                : status.sync_needed
                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                  : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
            }`}
          >
            {!status.last_synced_commit ? (
              <div className="flex items-center justify-between gap-2">
                <span>Memory sync: never synced.</span>
                <Button
                  className="px-2 py-1 text-xs"
                  onClick={() => syncMutation.mutate()}
                  disabled={syncMutation.isPending}
                >
                  {syncMutation.isPending ? 'Syncing…' : 'Sync now'}
                </Button>
              </div>
            ) : status.sync_needed ? (
              <div className="flex items-center justify-between gap-2">
                <span>Memory sync: {status.commits_behind} commits behind.</span>
                <Button
                  className="px-2 py-1 text-xs"
                  onClick={() => syncMutation.mutate()}
                  disabled={syncMutation.isPending}
                >
                  {syncMutation.isPending ? 'Syncing…' : 'Sync now'}
                </Button>
              </div>
            ) : (
              <span>Memory sync: up to date ({status.memory_total} entries).</span>
            )}
          </div>

          {status.memory_stale_count > 0 ? (
            <div className="flex items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
              <span>{status.memory_stale_count} entries need refresh.</span>
              <Button
                className="px-2 py-1 text-xs"
                onClick={() => refreshMutation.mutate(undefined)}
                disabled={refreshMutation.isPending}
              >
                {refreshMutation.isPending ? 'Refreshing…' : 'Refresh all'}
              </Button>
            </div>
          ) : null}

          {status.context_stale ? (
            <div className="flex items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
              <span>Explore context is stale.</span>
              <Button
                className="px-2 py-1 text-xs"
                onClick={() => exploreMutation.mutate()}
                disabled={exploreMutation.isPending}
              >
                {exploreMutation.isPending ? 'Exploring…' : 'Re-explore'}
              </Button>
            </div>
          ) : null}
        </div>
      )}

      <div className="grid gap-2 pb-3 sm:grid-cols-[minmax(0,1fr)_220px_180px_minmax(0,1fr)_auto_auto]">
        <input
          className={controlClass}
          value={queryText}
          onChange={(e) => setQueryText(e.target.value)}
          placeholder="Natural language query (e.g. how does auth work?)"
        />
        <select
          className={controlClass}
          value={category}
          onChange={(e) =>
            setCategory(e.target.value as MemoryCategory | 'all')
          }
        >
          <option value="all">All categories</option>
          {CATEGORIES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <select
          className={controlClass}
          value={sourceType}
          onChange={(e) =>
            setSourceType(e.target.value as MemorySourceType | 'all')
          }
        >
          <option value="all">All sources</option>
          {SOURCE_TYPES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <input
          className={controlClass}
          value={filePath}
          onChange={(e) => setFilePath(e.target.value)}
          list="memory-file-paths"
          placeholder="Filter by file path"
        />
        <label className="inline-flex items-center gap-2 rounded-md border border-border-subtle px-3 py-2 text-xs">
          <input
            type="checkbox"
            checked={staleOnly}
            onChange={(e) => setStaleOnly(e.target.checked)}
          />
          Stale only
        </label>
        <Button
          onClick={() => {
            setQueryText('')
            setCategory('all')
            setSourceType('all')
            setFilePath('')
            setStaleOnly(false)
          }}
          disabled={
            queryText.length === 0 &&
            category === 'all' &&
            sourceType === 'all' &&
            filePath.length === 0 &&
            !staleOnly
          }
        >
          Reset
        </Button>
      </div>

      <datalist id="memory-file-paths">
        {allFilePaths.map((path) => (
          <option key={path} value={path} />
        ))}
      </datalist>

      {selectedEntryId ? (
        <div className="mb-3 rounded-lg border border-border-subtle p-3 text-sm">
          {detailQuery.isLoading ? (
            <p className="text-muted">Loading entry details…</p>
          ) : detailQuery.isError ? (
            <p className="text-danger">Failed to load entry details.</p>
          ) : detailQuery.data ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-medium">Entry Detail</h2>
                <Button className="px-2 py-1 text-xs" onClick={() => setSelectedEntryId(null)}>
                  Close
                </Button>
              </div>
              <p className="whitespace-pre-wrap break-words text-sm">
                {detailQuery.data.entry.content}
              </p>
              <p className="text-xs text-muted">
                Source: {detailQuery.data.entry.source_type} • Confidence:{' '}
                {Math.round(detailQuery.data.entry.confidence * 100)}% • Stale:{' '}
                {detailQuery.data.entry.stale ? 'yes' : 'no'} • Covered:{' '}
                {detailQuery.data.entry.covered_at_commit
                  ? detailQuery.data.entry.covered_at_commit.slice(0, 8)
                  : '—'}
              </p>
              <p className="text-xs text-muted">
                Origin task:{' '}
                {detailQuery.data.entry.source_task_id ? (
                  <Link
                    to="/$taskId"
                    params={{ taskId: detailQuery.data.entry.source_task_id }}
                    className="underline"
                  >
                    {detailQuery.data.entry.source_task_id.slice(0, 8)}
                  </Link>
                ) : (
                  '—'
                )}{' '}
                • Source interaction:{' '}
                {detailQuery.data.entry.source_interaction_id || '—'}
              </p>
              <p className="text-xs text-muted">
                Supersedes:{' '}
                {detailQuery.data.supersedes && detailQuery.data.supersedes.length > 0
                  ? detailQuery.data.supersedes.join(', ')
                  : '—'}{' '}
                • Superseded by:{' '}
                {detailQuery.data.entry.superseded_by || '—'}
              </p>
              <div className="flex flex-wrap gap-1">
                {(detailQuery.data.entry.file_paths ?? []).map((path) => (
                  <button
                    key={path}
                    type="button"
                    className="inline-flex rounded bg-surface-alt px-1.5 py-0.5 text-[11px] hover:bg-muted/50"
                    onClick={() => setFilePath(path)}
                  >
                    {path}
                  </button>
                ))}
              </div>
              <div>
                <p className="text-xs font-medium text-muted">Used by tasks</p>
                {detailQuery.data.used_by_tasks.length === 0 ? (
                  <p className="text-xs text-muted">None</p>
                ) : (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {detailQuery.data.used_by_tasks.map((task) => (
                      <Link
                        key={task.task_id}
                        to="/$taskId"
                        params={{ taskId: task.task_id }}
                        className="text-xs"
                      >
                        {task.title} ({task.status})
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {listLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-accent" />
        </div>
      ) : listIsError ? (
        <div className="flex flex-1 items-center justify-center text-sm text-danger">
          {listError instanceof Error
            ? listError.message
            : 'Failed to load memory entries'}
        </div>
      ) : entries.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <p className="text-sm">No memory entries yet.</p>
          <p className="text-xs text-muted">
            Run <code>orca tasks retro</code> on completed tasks to extract
            memory.
          </p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border-subtle">
          <table className="w-full min-w-[1280px]">
            <thead className="[&_tr]:border-b">
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <th
                      key={header.id}
                      className="h-10 px-2 text-left align-middle text-sm font-medium whitespace-nowrap"
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext(),
                          )}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody className="[&_tr:last-child]:border-0">
              {table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b align-top transition-colors hover:bg-muted/10"
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="p-2 align-top">
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog.Root
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
          <Dialog.Content className="dialog-content fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2">
            <div className="dialog-content-inner w-[min(92vw,420px)]">
              <DialogChrome title="Delete Memory" />
              <div className="flex flex-col gap-4 p-4 text-sm">
                <p>
                  Delete this memory entry? This action cannot be undone.
                </p>
                {deleteTarget && (
                  <p className="line-clamp-3 rounded-md bg-surface-alt p-2 text-xs">
                    {deleteTarget.content}
                  </p>
                )}
                <div className="flex justify-end gap-2">
                  <Button
                    onClick={() => setDeleteTarget(null)}
                    disabled={deleteMutation.isPending}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => void confirmDelete()}
                    disabled={deleteMutation.isPending}
                  >
                    {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
                  </Button>
                </div>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}

export const Route = createFileRoute('/memory')({
  component: MemoryPage,
})
