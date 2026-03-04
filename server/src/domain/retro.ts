import { createHash } from 'node:crypto';
import type { DriverRegistry } from '../driver/registry';
import { loadPrompt } from '../prompts/loader';
import { createPhaseRunner } from '../shared/phase-runner';
import type { InteractionStore } from '../store/interactions';
import type { MemoryStore } from '../store/memory';
import type { TaskStore } from '../store/tasks';
import type { Config, MemoryCategory, MemoryEntry, Task } from '../types';
import { Phase } from '../types';
import { runTool } from '../worker/worker';
import { extractJSONArray, formatTemplate, resolvePhaseExecution } from './llm';

export interface RetroSummary {
  highlights: string[];
  improvement: string;
}

export interface RetroMemoryEntry {
  content: string;
  category: MemoryCategory;
  tags: string[];
  confidence: number;
  supersedes?: string;
  filePaths?: string[];
}

export interface RetroResult {
  summary: RetroSummary;
  memoryEntries: RetroMemoryEntry[];
  interactionId?: string;
  provenanceHash?: string;
  duplicateProvenance?: boolean;
}

export interface RetroDeps {
  repoDir: string;
  taskStore: TaskStore;
  interactionStore: InteractionStore;
  memoryStore: MemoryStore;
  config?: Config;
  registry?: DriverRegistry;
  toolOverride?: string;
  modelOverride?: string;
}

export async function runRetro(
  taskID: string,
  deps: RetroDeps,
): Promise<RetroResult> {
  const task = await deps.taskStore.get(taskID);
  if (!task) throw new Error(`task not found: ${taskID}`);

  const execution = resolvePhaseExecution({
    config: deps.config,
    registry: deps.registry,
    phase: Phase.retro,
    toolOverride: deps.toolOverride ?? '',
    modelOverride: deps.modelOverride ?? '',
  });

  if (!execution) {
    return { summary: buildRetroSummary(task), memoryEntries: [] };
  }

  // Compute shared provenance hash from task context BEFORE LLM call
  const retroContext = await collectRetroContext(deps, task);
  const provenanceHash = retroProvenanceHash(
    retroContext.planDiffs,
    retroContext.runDiffs,
    retroContext.reviewFeedback,
    retroContext.planReviewFeedback,
  );

  // Deduplicate: if this exact retro context was already processed, skip
  if (await deps.memoryStore.hasProvenanceHash(provenanceHash)) {
    return {
      summary: buildRetroSummary(task),
      memoryEntries: [],
      provenanceHash: provenanceHash,
      duplicateProvenance: true,
    };
  }

  const prompt = await buildRetroPrompt(deps, task, retroContext);
  const runPhase = await createPhaseRunner({
    config: deps.config,
    registry: deps.registry,
    repoDir: deps.repoDir,
    interactions: deps.interactionStore,
    runTool,
  });

  try {
    const { result, interactionId } = await runPhase(
      {
        taskId: taskID,
        taskRunId: `retro-${taskID.slice(0, 8)}`,
        phase: Phase.retro,
        prompt,
        toolOverride: deps.toolOverride ?? '',
        modelOverride: deps.modelOverride ?? '',
        exitErrorLabel: 'retro',
      },
      async (output, context) => {
        const entries = extractJSONArray<RetroMemoryEntry>(output) ?? [];
        const normalized = normalizeRetroEntries(entries);

        for (const entry of normalized) {
          const created = await deps.memoryStore.create({
            content: entry.content,
            category: entry.category,
            tags: entry.tags,
            confidence: entry.confidence,
            sourceTaskId: taskID,
            sourceInteractionId: context.interactionId,
            sourceType: 'retro',
            filePaths: entry.filePaths ?? [],
            provenanceHash: provenanceHash,
          });
          if (entry.supersedes?.trim()) {
            await deps.memoryStore
              .supersede(entry.supersedes, created.id)
              .catch(() => {});
          }
        }

        const summary: RetroSummary = {
          highlights:
            normalized.length > 0
              ? normalized.map((e) => e.content.slice(0, 120))
              : [`Task ${task.title} completed — no durable memory extracted.`],
          improvement:
            normalized.length > 0
              ? `${normalized.length} memory entries created from retro.`
              : 'No actionable insights found.',
        };

        return {
          summary,
          memoryEntries: normalized,
        };
      },
      (parsed) => ({
        qualityJson: JSON.stringify({
          entriesCreated: parsed.memoryEntries.length,
          summary: parsed.summary,
        }),
      }),
    );

    return {
      summary: result.summary,
      memoryEntries: result.memoryEntries,
      interactionId,
      provenanceHash: provenanceHash,
    };
  } catch (error) {
    return {
      summary: buildRetroSummary(task),
      memoryEntries: [],
      interactionId: errorInteractionID(error),
      provenanceHash: provenanceHash,
    };
  }
}

function errorInteractionID(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const id = (error as { interactionId?: unknown }).interactionId;
  if (typeof id !== 'string') return undefined;
  const normalized = id.trim();
  return normalized || undefined;
}

export function buildRetroSummary(
  task: Pick<Task, 'title' | 'status'>,
): RetroSummary {
  return {
    highlights: [
      `Task ${task.title.trim() || 'untitled'} reached status ${task.status}.`,
    ],
    improvement: 'Run LLM retro for deeper analysis.',
  };
}

interface RetroContext {
  planDiffs: string;
  runDiffs: string;
  reviewFeedback: string;
  planReviewFeedback: string;
  usedMemoryIDs: string[];
  usedProvenanceHashes: string[];
  usedMemoryContent: string[];
}

async function collectRetroContext(
  deps: RetroDeps,
  task: Task,
): Promise<RetroContext> {
  const interactions = await deps.interactionStore.list(task.id);

  const planDiffs = interactions
    .filter((i) => i.phase === Phase.plan && i.diff)
    .map((i) => i.diff!)
    .join('\n---\n');

  const runDiffs = interactions
    .filter((i) => i.phase === Phase.run && i.diff)
    .map((i) => i.diff!)
    .join('\n---\n');

  const reviews = await deps.taskStore.listReviews(task.id);
  const reviewFeedback = reviews
    .map((r) => r.feedback?.trim())
    .filter(Boolean)
    .join('\n---\n');

  const planReviewFeedback = reviews
    .filter(
      (r) =>
        (r as any).phase === Phase.plan ||
        r.feedback?.toLowerCase().includes('plan'),
    )
    .map((r) => r.feedback?.trim())
    .filter(Boolean)
    .join('\n---\n');

  const planInteractions = interactions.filter((i) => i.phase === Phase.plan);
  const usedMemoryIDs: string[] = [];
  const usedProvenanceHashes: string[] = [];
  const usedMemoryContent: string[] = [];

  for (const pi of planInteractions) {
    if (!pi.qualityJson) continue;
    try {
      const parsed = JSON.parse(pi.qualityJson) as {
        memory?: {
          entries?: Array<{
            id?: string;
            provenanceHash?: string;
            content?: string;
          }>;
        };
        usedMemoryIds?: string[];
      };
      if (parsed.usedMemoryIds) {
        usedMemoryIDs.push(...parsed.usedMemoryIds);
      }
      for (const entry of parsed.memory?.entries ?? []) {
        if (entry.id) usedMemoryIDs.push(entry.id);
        if (entry.provenanceHash)
          usedProvenanceHashes.push(entry.provenanceHash);
        if (entry.content) usedMemoryContent.push(entry.content);
      }
    } catch {
      /* ignore */
    }
  }

  return {
    planDiffs,
    runDiffs,
    reviewFeedback,
    planReviewFeedback,
    usedMemoryIDs,
    usedProvenanceHashes,
    usedMemoryContent,
  };
}

function retroProvenanceHash(
  planDiffs: string,
  runDiffs: string,
  reviewFeedback: string,
  planReviewFeedback: string,
): string {
  return createHash('sha256')
    .update(
      [planDiffs, runDiffs, reviewFeedback, planReviewFeedback].join('\n---\n'),
    )
    .digest('hex');
}

async function buildRetroPrompt(
  deps: RetroDeps,
  task: Task,
  ctx: RetroContext,
): Promise<string> {
  const template = await loadPrompt(deps.repoDir, 'retro');

  const existingMemory = await loadRelatedMemory(deps.memoryStore, task);

  return formatTemplate(template, [
    task.title.trim(),
    (task.description ?? '').trim() || '(none)',
    ctx.planDiffs || '(none)',
    ctx.runDiffs || '(none)',
    ctx.reviewFeedback || '(none)',
    ctx.planReviewFeedback || '(none)',
    ctx.usedMemoryContent.join('\n') || '(none)',
    ctx.usedMemoryIDs.join(', ') || '(none)',
    ctx.usedProvenanceHashes.join(', ') || '(none)',
    existingMemory || '(none)',
  ]);
}

async function loadRelatedMemory(
  memoryStore: MemoryStore,
  task: Task,
): Promise<string> {
  const entries = await memoryStore
    .search(task.title, 10)
    .catch(() => [] as MemoryEntry[]);
  if (entries.length === 0) return '';
  return entries
    .map(
      (e) =>
        `- [${e.id.slice(0, 8)}] (${e.category}) ${e.content.slice(0, 200)}`,
    )
    .join('\n');
}

function normalizeRetroEntries(
  entries: RetroMemoryEntry[],
): RetroMemoryEntry[] {
  const validCategories = new Set([
    'pattern',
    'pitfall',
    'preference',
    'convention',
  ]);
  return entries
    .filter((e) => e.content?.trim())
    .map((e) => ({
      content: e.content.trim(),
      category: validCategories.has(e.category) ? e.category : 'pattern',
      tags: Array.isArray(e.tags)
        ? e.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean)
        : [],
      confidence: Math.max(0, Math.min(1, Number(e.confidence ?? 0.7))),
      supersedes: e.supersedes?.trim() || undefined,
      filePaths: Array.isArray(e.filePaths)
        ? e.filePaths.map((p) => p.trim()).filter(Boolean)
        : undefined,
    }));
}
