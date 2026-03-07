import { INTERACTION_STATUSES } from '@orca/server/types';
import { useQuery } from '@tanstack/react-query';
import { Brain } from 'lucide-react';
import { api } from '../api';
import { queryKeys } from '../lib/queryKeys';
import type { Interaction } from '../types';
import { Badge, type BadgeVariant } from './Badge';

type Props = {
  interaction: Interaction;
};

const CATEGORY_TONE: Record<string, BadgeVariant> = {
  pattern: 'emerald',
  pitfall: 'rose',
  preference: 'amber',
  convention: 'cyan',
  dependency: 'orange',
  tooling: 'violet',
};

export function RetroSection({ interaction }: Props) {
  const enabled =
    interaction.type === 'retro' &&
    interaction.status === INTERACTION_STATUSES.completed;

  const { data: memories } = useQuery({
    queryKey: queryKeys.memoriesByInteraction(interaction.id),
    queryFn: () => api.getMemoriesByInteraction(interaction.id),
    enabled,
  });

  if (!enabled || !memories?.length) return null;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3">
      <div className="flex items-center gap-1.5 text-xs font-medium text-violet-400">
        <Brain size={14} />
        <span>
          {memories.length} {memories.length === 1 ? 'memory' : 'memories'}{' '}
          generated
        </span>
      </div>
      {memories.map((m) => (
        <div
          key={m.id}
          className="flex flex-col gap-1 rounded border border-border-subtle bg-surface-alt px-3 py-2 text-xs"
        >
          <div className="flex items-center gap-1.5">
            <Badge variant={CATEGORY_TONE[m.category] ?? 'default'}>
              {m.category}
            </Badge>
            {m.tags.map((t) => (
              <span key={t} className="text-muted">
                #{t}
              </span>
            ))}
          </div>
          <span className="text-foreground">{m.content}</span>
        </div>
      ))}
    </div>
  );
}
