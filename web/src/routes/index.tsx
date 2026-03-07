import { useMutation } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../api';
import { CreateTaskModal } from '../components/board/CreateTaskModal';
import { TasksToolbar } from '../components/board/TasksToolbar';
import {
  useConfigQuery,
  useModelsQuery,
  useRunningOperations,
  useTasksQuery,
} from '../hooks/queries';
import type { Task } from '../types';

type TaskNode = Task & { subRows?: TaskNode[] };

function buildTaskTree(tasks: Task[]): TaskNode[] {
  const map = new Map<string, TaskNode>();
  for (const t of tasks) map.set(t.id, { ...t });

  const roots: TaskNode[] = [];
  for (const node of map.values()) {
    if (node.parentId && map.has(node.parentId)) {
      const parent = map.get(node.parentId)!;
      (parent.subRows ??= []).push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

const columnHelper = createColumnHelper<TaskNode>();

const columns = [
  columnHelper.accessor('title', {
    header: 'Task',
    cell: ({ row, getValue }) => (
      <div
        className="flex items-center"
        style={{ paddingLeft: `${row.depth * 1.5}rem` }}
      >
        {row.getCanExpand() ? (
          <button
            onClick={row.getToggleExpandedHandler()}
            className="mr-1.5 cursor-pointer text-muted-foreground"
          >
            {row.getIsExpanded() ? '▾' : '▸'}
          </button>
        ) : (
          <span className="mr-1.5 w-3 inline-block" />
        )}
        {getValue()}
      </div>
    ),
  }),
  columnHelper.accessor('status', {
    header: 'Status',
    cell: (info) => info.getValue(),
  }),
  columnHelper.accessor('dependsOn', {
    header: 'Dependencies',
    cell: (info) => info.getValue(),
  }),
  columnHelper.accessor('createdAt', {
    header: 'Created',
    cell: (info) => info.getValue(),
  }),
  columnHelper.accessor('updatedAt', {
    header: 'Updated',
    cell: (info) => info.getValue(),
  }),
];

function TasksPage() {
  const tasksQuery = useTasksQuery();
  const configQuery = useConfigQuery();
  const allModelsQuery = useModelsQuery();
  const { isRunning } = useRunningOperations();
  const startTasksMutation = useMutation({
    mutationFn: (taskIds?: string[]) => api.startTasks(taskIds),
  });

  const [search, setSearch] = useState('');

  const tasks = tasksQuery.data ?? [];
  const loading = tasksQuery.isLoading || configQuery.isLoading;
  void allModelsQuery.data;

  const startTasks = async (taskIds?: string[]) => {
    try {
      await startTasksMutation.mutateAsync(taskIds);
    } catch (err: any) {
      toast.error(err?.message ?? 'Start failed');
    }
  };

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-accent" />
      </div>
    );
  }

  const startPending = isRunning('code');
  const merging = isRunning('merge');

  return (
    <TasksToolbar
      tasks={tasks}
      search={search}
      loading={{
        action: startTasksMutation.isPending,
        start: startPending,
        merge: merging,
      }}
      actions={{
        onStart: () => {
          void startTasks();
        },
        onMerge: async () => {
          try {
            const tasks = await api.listTasks();
            const approved = tasks.filter((t: any) => t.status === 'approved');
            if (approved.length === 0) {
              toast.info('No approved tasks to merge');
              return;
            }
            await Promise.all(approved.map((t: any) => api.mergeTask(t.id)));
            toast.success(`Merged ${approved.length} task(s)`);
          } catch (err: any) {
            toast.error(err?.message ?? 'Merge failed');
          }
        },
      }}
      onSearchChange={setSearch}
    />
  );
}

function Page() {
  const { data: tasks } = useTasksQuery();

  const data = buildTaskTree(tasks ?? []);

  const table = useReactTable({
    data,
    columns,
    getSubRows: (row) => row.subRows,
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    initialState: {
      expanded: true, // expand all by default
    },
  });

  if (!tasks || tasks.length === 0)
    return (
      <div className="flex flex-col flex-1 items-center gap-3 text-center justify-center">
        <p className="text-sm">No tasks yet.</p>
        <CreateTaskModal />
      </div>
    );

  return (
    <>
      <TasksPage />
      <div className="p-2">
        <table className="w-full">
          <thead className="[&_tr]:border-b">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr
                key={headerGroup.id}
                className="hover:bg-muted/10 data-[state=selected]:bg-muted border-b transition-colors"
              >
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    className="text-foreground h-10 px-2 text-left align-middle font-medium whitespace-nowrap [&:has([role=checkbox])]:pr-0"
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
                className="hover:bg-muted/10 data-[state=selected]:bg-muted border-b transition-colors"
              >
                {row.getVisibleCells().map((cell) => (
                  <td
                    key={cell.id}
                    className="p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0"
                  >
                    {cell.column.id === 'title' ? (
                      <Link
                        key={row.id}
                        to="/$taskId"
                        className="block"
                        params={{
                          taskId: row.original.id,
                        }}
                      >
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext(),
                        )}
                      </Link>
                    ) : (
                      flexRender(cell.column.columnDef.cell, cell.getContext())
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export const Route = createFileRoute('/')({
  component: Page,
});
