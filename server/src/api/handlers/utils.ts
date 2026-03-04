import { toErrorMessage } from '../../shared/errors';
import type { EventSink } from '../ws';

export async function parseBody<T>(request: {
  json: () => Promise<unknown>;
}): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

export function safeErrorMessage(error: unknown): string {
  return toErrorMessage(error);
}

export function broadcast(
  sink: EventSink,
  type: string,
  data: Record<string, unknown>,
): void {
  sink.broadcast(type, {
    ...data,
    timestamp: new Date().toISOString(),
  });
}

export function asBoolean(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

export function hashText(value: string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(value);
  return hasher.digest('hex');
}

export function randomID(prefix = ''): string {
  return prefix ? `${prefix}-${crypto.randomUUID()}` : crypto.randomUUID();
}
