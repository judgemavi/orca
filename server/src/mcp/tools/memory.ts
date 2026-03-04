import type { Tool } from '../types'
import { z } from 'zod'
import type { MemoryStore } from '../../store/memory'
import { getMemorySyncStatus, refreshMemoryEntries, syncMemoryWithGit } from '../../domain/memory-sync'
import { getMemoryDetail, queryMemory } from '../../domain/memory'
import { defineTool } from '../define-tool'

const requiredTrimmedString = (field: string) =>
  z.preprocess(
    (value) => value ?? '',
    z.coerce.string().trim().min(1, `${field} is required`),
  )

const optionalString = () =>
  z.preprocess(
    (value) => (value === undefined ? undefined : value ?? ''),
    z.coerce.string().optional(),
  )

const optionalTrimmedString = () =>
  z.preprocess(
    (value) => (value === undefined ? undefined : value ?? ''),
    z.coerce.string().trim().optional(),
  )

const memoryListSchema = z.object({
  category: optionalString(),
  tag: optionalString(),
  sourceType: optionalString(),
  filePath: optionalString(),
  stale: z.unknown().optional(),
  coveredBefore: optionalString(),
  q: optionalTrimmedString(),
  limit: z.number().optional().catch(undefined),
})

const memoryGetSchema = z.object({
  id: requiredTrimmedString('id'),
})

const memorySearchSchema = z.object({
  query: requiredTrimmedString('query'),
  limit: z.number().optional().catch(undefined),
})

const memoryQuerySchema = z.object({
  query: requiredTrimmedString('query'),
  limit: z.number().optional().catch(undefined),
})

const memoryUpdateSchema = z.object({
  id: requiredTrimmedString('id'),
  content: optionalString(),
  confidence: z.number().optional().catch(undefined),
  category: optionalString(),
})

const memoryDeleteSchema = z.object({
  id: requiredTrimmedString('id'),
})

const memorySyncSchema = z.object({})

const memoryRefreshSchema = z.object({
  entryId: optionalTrimmedString(),
})

const memoryStatusSchema = z.object({})

export function memoryTools(repoDir: string, memory: MemoryStore): Tool[] {
  return [
    defineTool({
      name: 'memory_list',
      description: 'List memory entries',
      schema: memoryListSchema,
      handler: async (input) => {
        const limit = Number.isFinite(input.limit)
          ? Math.max(1, Math.min(Number(input.limit), 500))
          : 50
        const q = input.q ?? ''
        if (q) {
          return queryMemory(memory, q, limit)
        }

        const rows = await memory.list({
          category: input.category as any,
          tag: input.tag,
          sourceType: input.sourceType as any,
          filePath: input.filePath,
          staleOnly: Boolean(input.stale),
          coveredBefore: input.coveredBefore,
        })
        return rows.slice(0, limit)
      },
    }),
    defineTool({
      name: 'memory_get',
      description: 'Get memory entry detail by id',
      schema: memoryGetSchema,
      handler: async (input) => getMemoryDetail(memory, input.id),
    }),
    defineTool({
      name: 'memory_search',
      description: 'Search memory entries by full-text query',
      schema: memorySearchSchema,
      handler: async (input) => {
        const limit = Number.isFinite(input.limit)
          ? Math.max(1, Math.min(Number(input.limit), 500))
          : 10
        return { entries: await memory.search(input.query, limit) }
      },
    }),
    defineTool({
      name: 'memory_query',
      description: 'Query memory with usage lineage metadata',
      schema: memoryQuerySchema,
      handler: async (input) => {
        const limit = Number.isFinite(input.limit)
          ? Math.max(1, Math.min(Number(input.limit), 500))
          : 10
        return { entries: queryMemory(memory, input.query, limit) }
      },
    }),
    defineTool({
      name: 'memory_update',
      description: 'Update a memory entry',
      schema: memoryUpdateSchema,
      handler: async (input) => {
        const id = input.id
        await memory.update(id, {
          content: input.content,
          confidence: input.confidence,
          category: input.category as any,
        })
        const updated = await memory.get(id)
        if (!updated) throw new Error(`memory entry not found: ${id}`)
        return { entry: updated }
      },
    }),
    defineTool({
      name: 'memory_delete',
      description: 'Delete a memory entry',
      schema: memoryDeleteSchema,
      handler: async (input) => {
        const id = input.id
        await memory.delete(id)
        return { id, deleted: true }
      },
    }),
    defineTool({
      name: 'memorySync',
      description: 'Trigger git-aware memory sync',
      schema: memorySyncSchema,
      handler: async () => syncMemoryWithGit(repoDir, memory),
    }),
    defineTool({
      name: 'memory_refresh',
      description: 'Refresh stale memory entries',
      schema: memoryRefreshSchema,
      handler: async (input) => refreshMemoryEntries(repoDir, memory, input.entryId ?? ''),
    }),
    defineTool({
      name: 'memory_status',
      description: 'Get memory sync + health status',
      schema: memoryStatusSchema,
      handler: async () => {
        const status = await getMemorySyncStatus(repoDir, memory)
        const health = await memory.buildHealthSummary()
        return {
          ...status,
          totalEntries: health.totalEntries,
          bySource: health.bySource,
          staleCount: health.staleCount,
          avgConfidence: health.avgConfidence,
        }
      },
    }),
  ]
}
