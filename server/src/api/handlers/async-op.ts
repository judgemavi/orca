import type { EventSink } from '../ws';
import { broadcast, randomID } from './utils';

type EventName<TContext> =
  | string
  | ((context: TContext) => string | null | undefined);
type EventPayload<TContext> =
  | Record<string, unknown>
  | ((context: TContext) => Record<string, unknown>);

interface AsyncOpEvent<TContext> {
  name: EventName<TContext>;
  payload?: EventPayload<TContext>;
}

interface AsyncOpStartContext {
  operationId: string;
}

interface AsyncOpCompletedContext<TResult> {
  operationId: string;
  result: TResult;
}

interface AsyncOpFailedContext {
  operationId: string;
  error: unknown;
}

export interface AsyncOpOptions<TResult> {
  idPrefix?: string;
  started?: AsyncOpEvent<AsyncOpStartContext>;
  completed?: AsyncOpEvent<AsyncOpCompletedContext<TResult>>;
  failed?: AsyncOpEvent<AsyncOpFailedContext>;
  run: (operationId: string) => Promise<TResult>;
}

export function asyncOp<TResult>(
  sink: EventSink,
  options: AsyncOpOptions<TResult>,
): { operationId: string } {
  const operationId = randomID(options.idPrefix ?? '');

  queueMicrotask(async () => {
    try {
      emitEvent(sink, options.started, { operationId });
      const result = await options.run(operationId);
      emitEvent(sink, options.completed, { operationId, result });
    } catch (error) {
      if (!options.failed) {
        throw error;
      }
      emitEvent(sink, options.failed, { operationId, error });
    }
  });

  return { operationId };
}

function emitEvent<TContext>(
  sink: EventSink,
  event: AsyncOpEvent<TContext> | undefined,
  context: TContext,
): void {
  if (!event) return;

  const name =
    typeof event.name === 'function' ? event.name(context) : event.name;
  if (!name) return;

  const payload =
    event.payload === undefined
      ? {}
      : typeof event.payload === 'function'
        ? event.payload(context)
        : event.payload;

  broadcast(sink, name, payload);
}
