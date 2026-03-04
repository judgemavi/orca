import { z } from 'zod'
import type { Tool } from '../types'
import type { JobQueue } from '../../queue/queue'
import { defineTool } from '../define-tool'

const jobStatusEnum = z
  .enum(['queued', 'running', 'completed', 'failed', 'cancelled'])
  .optional()

export function queueTools(deps: { queue: JobQueue }): Tool[] {
  const { queue } = deps

  return [
    defineTool({
      name: 'queue_list',
      description: 'List jobs in the queue',
      schema: z.object({
        status: jobStatusEnum,
        taskId: z.string().trim().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      handler: async (input) => {
        return await queue.list({
          status: input.status,
          taskId: input.taskId,
          limit: input.limit,
        })
      },
    }),

    defineTool({
      name: 'queue_get',
      description: 'Get a job by ID',
      schema: z.object({
        jobId: z.string().trim().min(1, 'jobId is required'),
      }),
      handler: async (input) => {
        const job = await queue.get(input.jobId)
        if (!job) throw new Error(`job not found: ${input.jobId}`)
        return job
      },
    }),

    defineTool({
      name: 'queue_cancel',
      description: 'Cancel a queued job by ID',
      schema: z.object({
        jobId: z.string().trim().min(1, 'jobId is required'),
      }),
      handler: async (input) => {
        const job = await queue.get(input.jobId)
        if (!job) throw new Error(`job not found: ${input.jobId}`)
        if (job.status !== 'queued') {
          throw new Error(`cannot cancel job in status: ${job.status}`)
        }
        const cancelled = await queue.cancel(input.jobId)
        return { jobId: input.jobId, cancelled }
      },
    }),

    defineTool({
      name: 'queue_drain',
      description: 'Cancel all queued jobs',
      schema: z.object({}),
      handler: async () => {
        const cancelled = await queue.drain()
        return { cancelled }
      },
    }),

    defineTool({
      name: 'queue_counts',
      description: 'Get job counts by status',
      schema: z.object({}),
      handler: async () => {
        return await queue.counts()
      },
    }),
  ]
}
