import type { JobType } from '@orca/types';
import type { EventSink } from '../api/ws';
import { log } from '../shared/logger';
import type { Job } from '../types/models';
import type { JobQueue } from './queue';

type JobHandler = (job: Job) => Promise<Record<string, unknown> | void>;

interface ProcessorDeps {
  queue: JobQueue;
  maxParallel: number;
  sink?: EventSink;
}

export class JobProcessor {
  private readonly handlers = new Map<string, JobHandler>();
  private fallbackHandler:
    | ((job: Job) => Promise<Record<string, unknown> | void>)
    | null = null;
  private running = 0;
  private mergeRunning = 0;
  private stopped = true;
  private ticking = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: ProcessorDeps) {}

  register(type: JobType | string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  setFallback(
    handler: (job: Job) => Promise<Record<string, unknown> | void>,
  ): void {
    this.fallbackHandler = handler;
  }

  start(): void {
    this.stopped = false;
    this.deps.queue.setOnEnqueue(() => this.scheduleTick());
    this.pollTimer = setInterval(() => this.scheduleTick(), 2_000);
    this.scheduleTick();
  }

  async stop(): Promise<void> {
    this.stopped = true;

    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    const deadline = Date.now() + 30_000;
    while (this.running > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (this.running > 0) {
      await this.deps.queue.requeueRunning();
    }
  }

  private scheduleTick(): void {
    queueMicrotask(() => this.tick());
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;

    try {
      while (!this.stopped) {
        const slots = this.deps.maxParallel - this.running;
        if (slots <= 0) break;

        const exclude = this.mergeRunning > 0 ? ['merge'] : undefined;
        const jobs = await this.deps.queue.claimNext(slots, exclude);
        if (jobs.length === 0) break;

        for (const job of jobs) {
          this.running++;
          const isMerge = this.isMergeType(job.type);
          if (isMerge) this.mergeRunning++;
          this.dispatch(job).finally(() => {
            this.running--;
            if (isMerge) this.mergeRunning--;
            this.scheduleTick();
          });
        }
      }
    } catch (err) {
      log.error('tick error', { error: String(err) });
    } finally {
      this.ticking = false;
    }
  }

  private isMergeType(type: string): boolean {
    return type === 'merge';
  }

  private async dispatch(job: Job): Promise<void> {
    const handler = this.handlers.get(job.type) ?? this.fallbackHandler;

    if (!handler) {
      await this.deps.queue
        .fail(job.id, `no handler registered for type ${job.type}`)
        .catch(() => {});
      return;
    }

    try {
      const result = await handler(job);
      await this.deps.queue
        .complete(job.id, result ?? undefined)
        .catch(() => {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.deps.queue.fail(job.id, message).catch(() => {});
    }
  }
}
