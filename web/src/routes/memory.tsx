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
  useMemoryMutation,
  useMemoryQuery,
} from '../hooks/queries'
import { controlClass } from '../lib/constants'
import { queryKeys } from '../lib/queryKeys'
import type { MemoryCategory, MemoryEntry } from '../types'

const CATEGORIES: MemoryCategory[] = [
  'pattern',
  'pitfall',
  'preference',
  'convention',
]

const CATEGORY_TONE: Record<MemoryCategory, string> = {
  pattern: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  pitfall: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  preference: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  convention: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
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
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<MemoryCategory | 'all'>('all')
  const [expandedContent, setExpandedContent] = useState<
    Record<string, boolean>
  >({})
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<EditDraft | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<MemoryEntry | null>(null)
  const queryClient = useQueryClient()

  const listParams = useMemo(() => {
    const trimmed = search.trim()
    return {
      ...(trimmed ? { q: trimmed } : {}),
      ...(category !== 'all' ? { category } : {}),
    }
  }, [search, category])

  const memoryQuery = useMemoryQuery(listParams)
  const updateMutation = useMemoryMutation()
  const deleteMutation = useDeleteMemoryMutation()
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

  const entries = memoryQuery.data ?? []

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
              <p
                className={
                  isExpanded
                    ? 'whitespace-pre-wrap break-words text-sm'
                    : 'line-clamp-2 break-words text-sm'
                }
              >
                {content}
              </p>
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
        header: 'Source',
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
    [draft, editingId, expandedContent, updateMutation.isPending],
  )

  const table = useReactTable({
    data: entries,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

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
        </div>
      </div>

      <div className="grid gap-2 pb-3 sm:grid-cols-[minmax(0,1fr)_220px_auto]">
        <input
          className={controlClass}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search memory (BM25)"
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
        <Button
          onClick={() => {
            setSearch('')
            setCategory('all')
          }}
          disabled={search.length === 0 && category === 'all'}
        >
          Reset
        </Button>
      </div>

      {memoryQuery.isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-accent" />
        </div>
      ) : memoryQuery.isError ? (
        <div className="flex flex-1 items-center justify-center text-sm text-danger">
          {memoryQuery.error instanceof Error
            ? memoryQuery.error.message
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
          <table className="w-full min-w-[980px]">
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
