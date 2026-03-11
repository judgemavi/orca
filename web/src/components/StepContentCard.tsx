import { INTERACTION_STATUSES } from '@orca/server/types';
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../api';
import type { useMergeHandler } from '../hooks/useMergeHandler';
import type { useTaskActions } from '../hooks/useTaskActions';
import {
  parseInteractionOutputData,
  parseInteractionOutputResult,
} from '../lib/interactionOutput';
import type { Interaction, Task } from '../types';
import { BreakdownSection } from './BreakdownSection';
import { DiffViewer } from './DiffViewer';
import { EvaluateSection } from './EvaluateSection';
import { MergeSection } from './MergeSection';
import { RetroSection } from './RetroSection';

interface StepContentProps {
  interaction: Interaction;
  task: Task;
  tools: string[];
  readOnly: boolean;
  merge: ReturnType<typeof useMergeHandler>;
  isLatestRunningMerge: boolean;
  isLatestFailedMerge: boolean;
  actions: ReturnType<typeof useTaskActions>;
}

function MarkdownContent({ content }: { content: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>;
}

function ContextContent({ interaction }: { interaction: Interaction }) {
  if (interaction.status !== INTERACTION_STATUSES.completed) return null;

  const data = parseInteractionOutputData(interaction.output);
  const markdown =
    (typeof data?.plan === 'string' && data.plan.trim() ? data.plan : null) ||
    (typeof data?.output === 'string' && data.output.trim()
      ? data.output
      : null);

  if (!markdown) return null;

  return (
    <div className="prose prose-sm max-h-[300px] max-w-none overflow-auto rounded-lg bg-surface p-4 text-xs dark:prose-invert">
      <MarkdownContent content={markdown} />
    </div>
  );
}

function DecisionContent({ interaction }: { interaction: Interaction }) {
  if (
    interaction.status !== INTERACTION_STATUSES.completed &&
    interaction.status !== INTERACTION_STATUSES.failed
  ) {
    return null;
  }

  const data = parseInteractionOutputData(interaction.output);
  const result = parseInteractionOutputResult(interaction.output);
  const feedback =
    typeof data?.feedback === 'string'
      ? data.feedback
      : typeof data?.output === 'string'
        ? data.output
        : null;

  if (!result && !feedback) return null;

  const isApproved = result === 'approved';
  const isFailed = interaction.status === INTERACTION_STATUSES.failed;

  return (
    <div
      className={[
        'rounded-lg p-2.5',
        isFailed
          ? 'bg-danger/10'
          : isApproved
            ? 'bg-emerald-500/10'
            : 'bg-amber-500/10',
      ].join(' ')}
    >
      <div className="mb-2 flex items-center gap-2 text-xs">
        {result && (
          <span
            className={[
              'rounded px-2 py-1 font-semibold uppercase tracking-wide',
              isFailed
                ? 'bg-danger/15 text-danger'
                : isApproved
                  ? 'bg-emerald-500/15 text-emerald-700'
                  : 'bg-amber-500/15 text-amber-700',
            ].join(' ')}
          >
            {result.replace(/_/g, ' ')}
          </span>
        )}
        {interaction.tool && interaction.tool !== 'manual' && (
          <span className="text-muted">tool: {interaction.tool}</span>
        )}
      </div>
      {isFailed && interaction.error && (
        <div className="mb-1 text-xs text-danger">{interaction.error}</div>
      )}
      {feedback && (
        <div className="whitespace-pre-wrap text-xs">{feedback}</div>
      )}
    </div>
  );
}

function CodeContent({
  interaction,
  task,
}: {
  interaction: Interaction;
  task: Task;
}) {
  const [diff, setDiff] = useState<string | null>(null);
  const [filesChanged, setFilesChanged] = useState<string[]>([]);

  useEffect(() => {
    if (interaction.status !== INTERACTION_STATUSES.completed) return;
    if (!interaction.commitSha) return;
    let cancelled = false;
    api.getInteractionDiff(task.id, interaction.id).then((res) => {
      if (!cancelled) {
        setDiff(res.diff || null);
        setFilesChanged(res.filesChanged);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [interaction.id, interaction.status, interaction.commitSha, task.id]);

  if (interaction.status !== INTERACTION_STATUSES.completed) return null;
  if (!diff) return null;

  return (
    <DiffViewer
      data={{
        taskId: task.id,
        title: task.title,
        diff,
        filesChanged,
        actions: [],
      }}
    />
  );
}

export function StepContentCard({
  interaction,
  task,
  tools,
  readOnly,
  merge,
  isLatestRunningMerge,
  isLatestFailedMerge,
  actions,
}: StepContentProps) {
  const type = interaction.type;

  if (type === 'evaluate') {
    return <EvaluateSection interaction={interaction} />;
  }
  if (type === 'breakdown') {
    return (
      <BreakdownSection
        interaction={interaction}
        proposals={actions.latestBreakdownProposals}
        onAccept={actions.handleAcceptBreakdown}
        onReject={actions.handleRejectBreakdown}
        accepting={actions.acceptBreakdownPending}
        rejecting={actions.rejectBreakdownPending}
      />
    );
  }
  if (type === 'retro') {
    return <RetroSection interaction={interaction} />;
  }

  if (type === 'context') {
    return <ContextContent interaction={interaction} />;
  }
  if (type === 'decision') {
    return <DecisionContent interaction={interaction} />;
  }
  if (type === 'code') {
    return <CodeContent interaction={interaction} task={task} />;
  }
  if (type === 'merge') {
    return (
      <MergeSection
        interaction={interaction}
        task={task}
        readOnly={readOnly}
        tools={tools}
        isLatestRunning={isLatestRunningMerge}
        isLatestFailed={isLatestFailedMerge}
        merge={merge}
      />
    );
  }

  const data = parseInteractionOutputData(interaction.output);
  const text = typeof data?.output === 'string' ? data.output : null;
  if (text && interaction.status === INTERACTION_STATUSES.completed) {
    return (
      <div className="prose prose-sm max-h-[300px] max-w-none overflow-auto rounded-lg bg-surface p-4 text-xs dark:prose-invert">
        <MarkdownContent content={text} />
      </div>
    );
  }

  return null;
}
