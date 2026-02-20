import type { ToolSummary } from '../../types'

interface Props {
  data: {
    scope: string
    total: number
    budget: number
    remaining: number
    tools: ToolSummary[]
  }
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(n)
}

export function CostCard({ data }: Props) {
  const total = data?.total ?? 0
  const budget = data?.budget ?? 0
  const tools = data?.tools ?? []
  const scope = data?.scope ?? 'Project'
  const pct = budget > 0 ? (total / budget) * 100 : 0

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-slate-700 bg-slate-900 p-4">
      <div className="text-sm font-semibold">
        <span>
          {scope} Costs: ${total.toFixed(2)}
        </span>
      </div>
      {budget > 0 && (
        <div className="flex items-center gap-2 text-[13px]">
          <span className="whitespace-nowrap text-slate-400">
            Budget: ${budget.toFixed(2)}
          </span>
          <div className="h-1.5 flex-1 overflow-hidden rounded bg-slate-800">
            <div
              className="h-full rounded transition-[width] duration-300"
              style={{
                width: `${Math.min(pct, 100)}%`,
                background: pct > 90 ? 'var(--status-failed)' : 'var(--accent)',
              }}
            />
          </div>
          <span className="min-w-10 text-right font-mono text-xs text-slate-400">
            {pct.toFixed(1)}%
          </span>
        </div>
      )}
      {tools.length > 0 && (
        <table className="w-full text-[13px]">
          <tbody>
            {tools.map((t) => (
              <tr key={t.tool}>
                <td className="py-1 font-mono font-medium">{t.tool}</td>
                <td className="py-1 pr-3 text-right font-mono">
                  ${t.cost.toFixed(2)}
                </td>
                <td className="py-1 font-mono text-xs text-slate-400">
                  {formatTokens(t.input_tokens)} in /{' '}
                  {formatTokens(t.output_tokens)} out
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
