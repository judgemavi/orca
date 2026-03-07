import { createFileRoute, Link } from '@tanstack/react-router';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { useState } from 'react';
import { CreateTaskModal } from '../components/CreateTaskModal';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/table';
import { useTasksQuery } from '../hooks/queries';
import type { Task } from '../types';

const columnHelper = createColumnHelper<Task>();

const columns = [
  columnHelper.accessor('title', {
    header: 'Task',
    cell: (info) => info.getValue(),
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

function Page() {
  const { data: tasks } = useTasksQuery();
  const [search, setSearch] = useState('');

  const table = useReactTable({
    data: tasks ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
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
      <div className="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search tasks"
            className="w-full max-w-60 rounded-md border border-border-subtle px-2.5 py-1 text-xs outline-none focus:border-accent"
          />
          <CreateTaskModal />
        </div>
      </div>
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id}>
                  {header.isPlaceholder
                    ? null
                    : flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id}>
                  {cell.column.id === 'title' ? (
                    <Link
                      to="/$taskId"
                      className="block"
                      params={{ taskId: row.original.id }}
                    >
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </Link>
                  ) : (
                    flexRender(cell.column.columnDef.cell, cell.getContext())
                  )}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}

export const Route = createFileRoute('/')({
  component: Page,
});
