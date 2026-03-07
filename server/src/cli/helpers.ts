import {
  cancel as clackCancel,
  confirm as clackConfirm,
  isCancel,
  select,
  text,
} from '@clack/prompts';
import type { TaskStore } from '../store/tasks';
import type { Task, TaskStatus } from '../types';

export type TaskFilter = (task: Task) => boolean;

export const allTasks: TaskFilter = () => true;
export const pendingTasks: TaskFilter = (task) =>
  task.status === 'pending' || task.status === 'planned';
export const reviewTasks: TaskFilter = (task) => task.status === 'review';
export const runningTasks: TaskFilter = (task) => task.status === 'running';
export const stoppedTasks: TaskFilter = (task) => task.status === 'stopped';

export function statusIcon(status: TaskStatus | string): string {
  switch (status) {
    case 'merged':
    case 'approved':
      return '✓';
    case 'running':
      return '●';
    case 'failed':
      return '✗';
    case 'review':
      return '◐';
    default:
      return '○';
  }
}

export function short(id: string): string {
  return id.slice(0, 8);
}

function formatTaskOption(task: Task): string {
  return `${statusIcon(task.status)} ${short(task.id)}  ${task.title} (${task.status})`;
}

export async function pickTask(
  store: TaskStore,
  title: string,
  filter: TaskFilter = allTasks,
): Promise<Task> {
  const tasks = (await store.list()).filter(filter);
  if (tasks.length === 0) {
    throw new Error('no matching tasks found');
  }

  const selected = await select<string>({
    message: title,
    options: tasks.map((task) => ({
      value: task.id,
      label: formatTaskOption(task),
    })),
  });

  const selectedID = ensureNotCancelled<string>(selected);
  const task = await store.get(selectedID);
  if (!task) {
    throw new Error(`task not found: ${selectedID}`);
  }
  return task;
}

export async function confirm(
  message: string,
  initialValue = false,
): Promise<boolean> {
  const value = await clackConfirm({ message, initialValue });
  return ensureNotCancelled<boolean>(value);
}

export async function textInput(
  message: string,
  opts?: {
    placeholder?: string;
    defaultValue?: string;
    required?: boolean;
    validate?: (value: string) => string | Error;
  },
): Promise<string> {
  const value = await text({
    message,
    placeholder: opts?.placeholder ?? opts?.defaultValue,
    defaultValue: opts?.defaultValue,
    validate: (raw) => {
      const normalized = (raw ?? '').trim();
      if (opts?.required && !normalized && !opts?.defaultValue) {
        return 'required';
      }
      if (normalized) {
        const validated = opts?.validate?.(normalized);
        return validated ?? undefined;
      }
    },
  });

  return ensureNotCancelled<string>(value).trim();
}

export async function pickFromList(
  message: string,
  options: Array<{ label: string; value: string }>,
  initialValue?: string,
): Promise<string> {
  if (options.length === 0) {
    throw new Error('no options available');
  }
  const selected = await select<string>({
    message,
    options,
    initialValue,
  });
  return ensureNotCancelled<string>(selected);
}

export function ensureNotCancelled<T>(value: T | symbol): T {
  if (isCancel(value)) {
    clackCancel('Operation cancelled.');
    throw new Error('operation cancelled');
  }
  return value as T;
}
