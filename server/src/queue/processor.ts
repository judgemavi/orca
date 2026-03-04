import type { Job, JobType } from '../types'
import type { EventSink } from '../api/ws'
import type { JobQueue } from './queue'

export type JobHandler = (job: Job) => Promise<Record<string, unknown> | void>

interface ProcessorDeps {
  queue: JobQueue
  maxParallel: number
  sink?: EventSink
}

export class JobProcessor {
  private readonly handlers = new Map<string, JobHandler>()
  private running = 0
  private stopped = false
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private kickScheduled = false

  constructor(private readonly deps: ProcessorDeps) {}

  register(type: JobType, handler: JobHandler): void {
    this.handlers.set(type, handler)
  }

  start(): void {
    this.stopped = false
    this.deps.queue.setOnEnqueue(() => this.kick())
    this.pollTimer = setInterval(() => this.tick(), 1_000)
    this.kick()
  }

  async stop(): Promise<void> {
    this.stopped = true

    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }

    const deadline = Date.now() + 30_000
    while (this.running > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    if (this.running > 0) {
      await this.deps.queue.requeueRunning()
    }
  }

  kick(): void {
    if (this.kickScheduled) return
    this.kickScheduled = true
    queueMicrotask(() => {
      this.kickScheduled = false
      this.tick()
    })
  }

  private async tick(): Promise<void> {
    if (this.stopped) return

    const slots = this.deps.maxParallel - this.running
    if (slots <= 0) return

    let jobs: Job[]
    try {
      jobs = await this.deps.queue.claim(this.deps.maxParallel)
    } catch (err) {
      console.error('[queue] claim error:', err)
      return
    }

    for (const job of jobs) {
      this.running++
      this.dispatch(job).finally(() => {
        this.running--
        this.kick()
      })
    }
  }

  private async dispatch(job: Job): Promise<void> {
    const handler = this.handlers.get(job.type)

    if (!handler) {
      await this.deps.queue.fail(job.id, `no handler registered for type ${job.type}`).catch(() => {})
      return
    }

    try {
      const result = await handler(job)
      await this.deps.queue.complete(job.id, result ?? undefined).catch(() => {})
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.deps.queue.fail(job.id, message).catch(() => {})
    }
  }
}
