import type { Command } from 'commander'
import type { InteractionStore } from '../../store/interactions'
import { isJSONMode, printJSON, printTable } from '../format'
import { short } from '../helpers'

export function registerCostsCommand(program: Command, interactions: InteractionStore) {
  program
    .command('costs')
    .description('Show project/run cost totals, tool breakdown, and recent runs')
    .option('--run <id>', 'run id or run id prefix')
    .option('--limit <n>', 'recent runs to show', '10')
    .action(async (opts: { run?: string; limit?: string }) => {
      const limit = clampLimit(opts.limit)
      const requestedRun = (opts.run ?? '').trim()

      if (requestedRun) {
        const runID = await resolveRunID(interactions, requestedRun)
        const payload = {
          scope: 'run' as const,
          runId: runID,
          totalCost: await interactions.runTotal(runID),
          byTool: await interactions.runSummary(runID),
          runs: await interactions.listRuns(limit),
        }
        return renderCosts(payload)
      }

      const payload = {
        scope: 'project' as const,
        runId: '',
        totalCost: await interactions.projectTotal(),
        byTool: await interactions.projectSummary(),
        runs: await interactions.listRuns(limit),
      }
      return renderCosts(payload)
    })
}

function renderCosts(input: {
  scope: 'project' | 'run'
  runId: string
  totalCost: number
  byTool: Array<{ tool: string; inputTokens: number; outputTokens: number; cost: number }>
  runs: Array<{
    runId: string
    interactions: number
    inputTokens: number
    outputTokens: number
    cost: number
    startedAt: string
    finishedAt: string
  }>
}) {
  if (isJSONMode()) {
    printJSON(input)
    return
  }

  const scopeLabel = input.scope === 'run' ? `Run ${short(input.runId)}` : 'Project'
  console.log(`${scopeLabel} total: $${input.totalCost.toFixed(4)}`)
  console.log('')
  console.log('By tool:')
  console.log(
    printTable(
      input.byTool.map((item) => ({
        tool: item.tool,
        inputTokens: formatInt(item.inputTokens),
        outputTokens: formatInt(item.outputTokens),
        cost: `$${item.cost.toFixed(4)}`,
      })),
    ),
  )
  console.log('')
  console.log('Recent runs:')
  console.log(
    printTable(
      input.runs.map((run) => ({
        run: short(run.runId),
        interactions: run.interactions,
        cost: `$${run.cost.toFixed(4)}`,
        inputTokens: formatInt(run.inputTokens),
        outputTokens: formatInt(run.outputTokens),
        finishedAt: run.finishedAt || run.startedAt,
      })),
    ),
  )
}

async function resolveRunID(interactions: InteractionStore, prefix: string): Promise<string> {
  const matches = await interactions.findRunIDsByPrefix(prefix, 25)
  if (matches.length === 0) {
    throw new Error(`no run found for prefix: ${prefix}`)
  }
  const exact = matches.find((id) => id === prefix)
  if (exact) return exact
  if (matches.length === 1) return matches[0] as string
  throw new Error(
    `run prefix is ambiguous (${prefix}): ${matches.slice(0, 5).map((id) => short(id)).join(', ')}`,
  )
}

function clampLimit(raw: string | undefined): number {
  const parsed = Number.parseInt((raw ?? '').trim(), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return 10
  return Math.min(parsed, 100)
}

function formatInt(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}
