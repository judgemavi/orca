import { TASK_STATUSES } from '@orca/types';
import type { OrcaDrizzleDB } from '../db/connection';
import type { MemoryStore } from '../store/memory';
import * as taskStore from '../store/tasks';
import type { MemoryEntry } from '../types/models';

interface RetrievalBudgets {
  summary: number;
  exact: number;
  semantic: number;
  recency: number;
  siblings: number;
}

interface BudgetedRetrievalInput {
  taskId?: string;
  title: string;
  description: string;
  filePaths?: string[];
  budgets?: Partial<RetrievalBudgets>;
  syncer?: MemoryRetrievalSyncer;
}

export interface BudgetedRetrievalResult {
  summary: MemoryEntry | null;
  exactMatches: MemoryEntry[];
  semanticMatches: MemoryEntry[];
  recencyMatches: MemoryEntry[];
  siblingTasks: Array<{
    id: string;
    title: string;
    status: string;
    plan: string;
  }>;
  totalEntries: number;
  staleRefreshed: number;
}

interface MemoryRetrievalSyncer {
  refresh(entryID: string): Promise<unknown>;
}

const DEFAULT_BUDGETS: RetrievalBudgets = {
  summary: 1,
  exact: 4,
  semantic: 6,
  recency: 3,
  siblings: 3,
};

export async function retrieveBudgetedMemory(
  memory: MemoryStore,
  db: OrcaDrizzleDB,
  input: BudgetedRetrievalInput,
): Promise<BudgetedRetrievalResult> {
  const budgets: RetrievalBudgets = {
    ...DEFAULT_BUDGETS,
    ...(input.budgets ?? {}),
  };
  const files = normalizeList(input.filePaths ?? []);
  const query = `${input.title.trim()}\n${input.description.trim()}`.trim();
  const seen = new Set<string>();

  const refreshed = new Set<string>();
  let staleRefreshed = 0;
  const prepareEntries = async (
    entries: MemoryEntry[],
  ): Promise<MemoryEntry[]> => {
    const out: MemoryEntry[] = [];
    for (const entry of entries) {
      const prepared = await prepareEntry(entry);
      if (prepared) out.push(prepared);
    }
    return out;
  };

  const prepareEntry = async (
    entry: MemoryEntry,
  ): Promise<MemoryEntry | null> => {
    if (!entry.stale || !input.syncer) return entry;
    if (refreshed.has(entry.id)) {
      return await memory.get(entry.id);
    }
    refreshed.add(entry.id);
    try {
      await input.syncer.refresh(entry.id);
      staleRefreshed += 1;
    } catch {
      return entry;
    }
    return (await memory.get(entry.id)) ?? entry;
  };

  // Layer 1: project summary
  let summary: MemoryEntry | null = null;
  if (budgets.summary > 0) {
    const summaries = await memory.list({ tag: 'project-summary' });
    for (const entry of summaries) {
      const prepared = await prepareEntry(entry);
      if (!prepared) continue;
      summary = prepared;
      seen.add(prepared.id);
      break;
    }
  }

  // Layer 2: exact file path matches
  const exactMatches = (
    await prepareEntries(
      dedupeEntries(await memory.findByFilePaths(files)).filter(
        (entry) => !seen.has(entry.id),
      ),
    )
  ).slice(0, budgets.exact);
  for (const entry of exactMatches) seen.add(entry.id);

  // Layer 3: vector semantic search with query expansion
  const expandedQueries = [query];
  const titleOnly = input.title.trim();
  if (titleOnly && titleOnly !== query) expandedQueries.push(titleOnly);

  const allScored = await Promise.all(
    expandedQueries.map((q) =>
      memory.searchWithScores(q, budgets.semantic * 2),
    ),
  );
  const bestByEntry = new Map<string, { entry: MemoryEntry; score: number }>();
  for (const results of allScored) {
    for (const { entry, score } of results) {
      if (seen.has(entry.id)) continue;
      const existing = bestByEntry.get(entry.id);
      if (!existing || score > existing.score) {
        bestByEntry.set(entry.id, { entry, score });
      }
    }
  }
  const semanticMatches = await prepareEntries(
    [...bestByEntry.values()]
      .sort((a, b) => b.score - a.score)
      .map(({ entry }) => entry)
      .slice(0, budgets.semantic),
  );
  for (const entry of semanticMatches) seen.add(entry.id);

  // Layer 4: recency
  const recencyMatches = await prepareEntries(
    [...(await memory.list())]
      .reverse()
      .filter((entry) => !seen.has(entry.id))
      .slice(0, budgets.recency),
  );
  for (const entry of recencyMatches) seen.add(entry.id);

  // Siblings: related active tasks by file overlap
  const siblingCandidatesTasks = (await taskStore.listTasks(db))
    .filter(
      (task) =>
        task.id !== (input.taskId ?? '') &&
        (task.status === TASK_STATUSES.planned ||
          task.status === TASK_STATUSES.running ||
          task.status === TASK_STATUSES.review ||
          task.status === TASK_STATUSES.approved),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, budgets.siblings * 3);
  const siblingTasks = siblingCandidatesTasks
    .slice(0, budgets.siblings)
    .map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      plan: '',
    }));

  // Bump retrieval counts for all returned entries (reinforcement signal)
  const retrievedIds = [...seen];
  if (retrievedIds.length > 0) {
    await memory.bumpRetrievalCount(retrievedIds);
  }

  return {
    summary,
    exactMatches,
    semanticMatches,
    recencyMatches,
    siblingTasks,
    totalEntries: seen.size,
    staleRefreshed,
  };
}

export function buildMemoryContext(result: BudgetedRetrievalResult): string {
  const entries = [
    ...result.exactMatches,
    ...result.semanticMatches,
    ...result.recencyMatches,
  ];
  const blocks: string[] = [];

  if (result.summary?.content.trim()) {
    blocks.push(
      ['## Project Context', '', result.summary.content.trim()].join('\n'),
    );
  }

  if (entries.length > 0) {
    const lines = ['## Memory Context', ''];
    for (const [idx, entry] of entries.entries()) {
      lines.push(`${idx + 1}. ${entry.content.trim()}`);
      lines.push(`   - category: ${entry.category}`);
      lines.push(`   - confidence: ${entry.confidence.toFixed(2)}`);
      if (entry.filePaths?.length) {
        lines.push(`   - files: ${entry.filePaths.join(', ')}`);
      }
    }
    blocks.push(lines.join('\n'));
  }

  if (result.siblingTasks.length > 0) {
    const lines = ['## Related Active Tasks', ''];
    for (const [idx, task] of result.siblingTasks.entries()) {
      lines.push(`${idx + 1}. ${task.title} (${task.status})`);
    }
    blocks.push(lines.join('\n'));
  }

  return blocks.join('\n\n').trim();
}

function dedupeEntries(entries: MemoryEntry[]): MemoryEntry[] {
  const seen = new Set<string>();
  const out: MemoryEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

function normalizeList(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}
