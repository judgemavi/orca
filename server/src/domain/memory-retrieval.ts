import type { MemoryStore } from '../store/memory';
import type { TaskStore } from '../store/tasks';
import type { MemoryEntry } from '../types';
import { TaskStatus } from '../types';

export interface RetrievalBudgets {
  summary: number;
  exact: number;
  fts: number;
  tags: number;
  recency: number;
  siblings: number;
}

export interface BudgetedRetrievalInput {
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
  tagMatches: MemoryEntry[];
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

export interface MemoryRetrievalSyncer {
  refresh(entryID: string): Promise<unknown>;
}

const DEFAULT_BUDGETS: RetrievalBudgets = {
  summary: 1,
  exact: 4,
  fts: 4,
  tags: 3,
  recency: 3,
  siblings: 3,
};

export async function retrieveBudgetedMemory(
  memory: MemoryStore,
  tasks: TaskStore,
  input: BudgetedRetrievalInput,
): Promise<BudgetedRetrievalResult> {
  const budgets: RetrievalBudgets = {
    ...DEFAULT_BUDGETS,
    ...(input.budgets ?? {}),
  };
  const files = normalizeList(input.filePaths ?? []);
  const query = `${input.title.trim()}\n${input.description.trim()}`.trim();
  const tags = extractTagsFromText(query);
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
      // Keep original stale entry when refresh fails.
      return entry;
    }
    return (await memory.get(entry.id)) ?? entry;
  };

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

  const exactMatches = (
    await prepareEntries(
      dedupeEntries(await memory.findByFilePaths(files)).filter(
        (entry) => !seen.has(entry.id),
      ),
    )
  ).slice(0, budgets.exact);
  for (const entry of exactMatches) seen.add(entry.id);

  const semanticMatches = await prepareEntries(
    (await memory.searchExcluding(query, budgets.fts * 2, []))
      .filter((entry) => !seen.has(entry.id))
      .slice(0, budgets.fts),
  );
  for (const entry of semanticMatches) seen.add(entry.id);

  const tagMatches: MemoryEntry[] = [];
  for (const tag of tags) {
    if (tagMatches.length >= budgets.tags) break;
    const rows = (await memory.list({ tag })).filter(
      (entry) => !seen.has(entry.id),
    );
    for (const row of rows) {
      if (tagMatches.length >= budgets.tags) break;
      const prepared = await prepareEntry(row);
      if (!prepared) continue;
      tagMatches.push(prepared);
      seen.add(row.id);
    }
  }

  const recencyMatches = await prepareEntries(
    [...(await memory.list())]
      .reverse()
      .filter((entry) => !seen.has(entry.id))
      .slice(0, budgets.recency),
  );
  for (const entry of recencyMatches) seen.add(entry.id);

  const siblingCandidatesTasks = (await tasks.list())
    .filter(
      (task) =>
        task.id !== (input.taskId ?? '') &&
        (task.status === TaskStatus.planned ||
          task.status === TaskStatus.running ||
          task.status === TaskStatus.review ||
          task.status === TaskStatus.approved),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, budgets.siblings * 3);
  const siblingCandidates = (
    await Promise.all(
      siblingCandidatesTasks.map(async (task) => ({
        task,
        overlap: overlapCount(await tasks.getFilePaths(task.id), files),
      })),
    )
  ).sort((a, b) => b.overlap - a.overlap);
  const siblingTasks = siblingCandidates
    .slice(0, budgets.siblings)
    .map((task) => ({
      id: task.task.id,
      title: task.task.title,
      status: task.task.status,
      plan: (task.task.plan ?? '').trim(),
    }));

  return {
    summary,
    exactMatches: exactMatches,
    semanticMatches: semanticMatches,
    tagMatches: tagMatches,
    recencyMatches: recencyMatches,
    siblingTasks: siblingTasks,
    totalEntries: seen.size,
    staleRefreshed,
  };
}

export function buildMemoryContext(result: BudgetedRetrievalResult): string {
  const entries = [
    ...result.exactMatches,
    ...result.semanticMatches,
    ...result.tagMatches,
    ...result.recencyMatches,
  ];
  const blocks: string[] = [];

  if (result.summary && result.summary.content.trim()) {
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
      if (task.plan) {
        lines.push(`   - plan: ${firstLine(task.plan)}`);
      }
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

function extractTagsFromText(text: string): string[] {
  return normalizeList(
    text
      .toLowerCase()
      .split(/[^a-z0-9_/-]+/g)
      .filter((word) => word.length >= 4)
      .slice(0, 20),
  );
}

function overlapCount(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const normalized = new Set(right.map((path) => path.trim()).filter(Boolean));
  if (normalized.size === 0) return 0;
  let overlap = 0;
  for (const path of left) {
    if (normalized.has(path.trim())) overlap += 1;
  }
  return overlap;
}

function firstLine(value: string): string {
  const line = value
    .split('\n')
    .map((item) => item.trim())
    .find(Boolean);
  return line ?? '';
}
