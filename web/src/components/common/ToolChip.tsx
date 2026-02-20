const TOOL_COLORS: Record<string, string> = {
  claude: 'bg-fuchsia-100 text-fuchsia-700',
  codex: 'bg-blue-100 text-blue-700',
  aider: 'bg-emerald-100 text-emerald-700',
}

export function ToolChip({ tool }: { tool: string }) {
  const cls = TOOL_COLORS[tool] ?? 'bg-slate-700 text-slate-300'
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 font-mono text-xs font-semibold tracking-wide ${cls}`}
    >
      {tool}
    </span>
  )
}
