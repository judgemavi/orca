import {
  cancel as clackCancel,
  confirm as clackConfirm,
  isCancel,
  select,
  text,
} from '@clack/prompts';
import type { TaskStatus } from '@orca/types';

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
    validate?: (value: string) => string | Error | undefined;
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
