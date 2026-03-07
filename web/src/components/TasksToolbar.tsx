import type { Task } from '../types';
import { CreateTaskModal } from './CreateTaskModal';

interface Props {
  tasks: Task[];
  search: string;
  onSearchChange: (value: string) => void;
}

function ToolbarSearch({
  search,
  onSearchChange,
}: {
  search: string;
  onSearchChange: (value: string) => void;
}) {
  return (
    <input
      type="text"
      value={search}
      onChange={(event) => onSearchChange(event.target.value)}
      placeholder="Search tasks"
      className="w-full max-w-60 rounded-md border border-border-subtle px-2.5 py-1 text-xs outline-none focus:border-accent"
    />
  );
}

export function TasksToolbar({ search, onSearchChange }: Props) {
  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ToolbarSearch search={search} onSearchChange={onSearchChange} />
        <CreateTaskModal />
      </div>
    </div>
  );
}
