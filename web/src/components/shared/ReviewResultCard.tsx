interface ReviewResultCheck {
  key: string;
  label: string;
  passed: boolean;
}

interface ReviewResultFinding {
  id: string;
  summary: string;
  detail: string;
  passed: boolean;
  filePath?: string;
  line?: number;
}

interface ReviewResultCardProps {
  approved: boolean;
  feedback: string;
  taskId?: string;
  tool?: string;
  checks?: ReviewResultCheck[];
  findings?: ReviewResultFinding[];
  prompt?: string;
  cost?: string;
  dismissed?: boolean;
}

export function ReviewResultCard({
  approved,
  feedback,
  taskId,
  tool,
  checks = [],
  findings = [],
  prompt,
  cost,
  dismissed = false,
}: ReviewResultCardProps) {
  const isDismissed = dismissed && !approved;

  return (
    <div
      className={[
        'rounded-lg p-2.5',
        isDismissed
          ? 'bg-surface-alt opacity-60'
          : approved
            ? 'bg-emerald-500/10 shadow-sm shadow-emerald-500/10'
            : 'bg-amber-500/10 shadow-sm shadow-amber-500/10',
      ].join(' ')}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <span
          className={[
            'rounded px-2 py-1 font-semibold uppercase tracking-wide',
            isDismissed
              ? 'bg-surface text-muted'
              : approved
                ? 'bg-emerald-500/15 text-emerald-700'
                : 'bg-rose-500/15 text-rose-700',
          ].join(' ')}
        >
          {isDismissed ? 'dismissed' : approved ? 'pass' : 'fail'}
        </span>
        {taskId ? (
          <span className="text-muted">
            task: <span className="font-mono">{taskId.slice(0, 8)}</span>
          </span>
        ) : null}
        {tool ? <span className="text-muted">tool: {tool}</span> : null}
        {cost ? <span className="text-muted">cost: {cost}</span> : null}
      </div>

      {checks.length > 0 ? (
        <div className="mb-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
          {checks.map((check) => (
            <div
              key={check.key}
              className="flex items-center justify-between rounded border border-border-subtle bg-surface-alt/40 px-2 py-1 text-xs"
            >
              <span>{check.label}</span>
              <span
                className={check.passed ? 'text-emerald-700' : 'text-rose-700'}
              >
                {check.passed ? 'pass' : 'fail'}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {findings.length > 0 ? (
        <div className="mb-2 space-y-2">
          {findings.map((finding, index) => (
            <details
              key={finding.id}
              className="rounded border border-border-subtle bg-surface-alt/40"
              open={index === 0}
            >
              <summary className="cursor-pointer px-2 py-1.5 text-xs">
                <span
                  className={[
                    'mr-1.5 font-semibold',
                    finding.passed ? 'text-emerald-700' : 'text-rose-700',
                  ].join(' ')}
                >
                  {finding.passed ? 'pass' : 'fail'}
                </span>
                <span>{finding.summary}</span>
                {finding.filePath ? (
                  <span className="ml-1.5 font-mono text-[11px] text-muted">
                    {finding.filePath}
                    {finding.line ? `:${finding.line}` : ''}
                  </span>
                ) : null}
              </summary>
              <div className="border-t border-border-subtle px-2 py-2 text-xs whitespace-pre-wrap">
                {finding.detail}
              </div>
            </details>
          ))}
        </div>
      ) : null}

      {prompt ? (
        <div className="mb-2 rounded bg-surface px-2 py-1.5 text-[11px] italic">
          {prompt}
        </div>
      ) : null}

      <div className="whitespace-pre-wrap text-xs">
        {feedback || 'No review feedback.'}
      </div>
    </div>
  );
}
