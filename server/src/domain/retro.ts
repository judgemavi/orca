import { createHash } from 'node:crypto';
import type { OrcaDrizzleDB } from '../db/connection';
import type { Config, TaskEntry } from '../db/schema';
import type { ToolPluginRegistry } from '../plugin/registry';
import { loadPrompt } from '../prompts/loader';
import { gitRun } from '../shared/git';
import { createInteractionRunner } from '../shared/interaction-runner';
import type { InteractionStore } from '../store/interactions';
import type { MemoryStore } from '../store/memory';
import * as taskStore from '../store/tasks';
import type { MemoryCategory } from '../types/constants';
import type { MemoryEntry } from '../types/models';
import { runTool } from '../worker/worker';
import { retroSchema } from '../workflow/schema';
import type { WorkflowStore } from '../workflow/store';
import { extractJSONArray, formatTemplate, resolveExecution } from './llm';

interface RetroSummary {
  highlights: string[];
  improvement: string;
}

interface RetroMemoryEntry {
  content: string;
  category: MemoryCategory;
  tags: string[];
  confidence: number;
  supersedes?: string;
  filePaths?: string[];
}

interface RetroResult {
  summary: RetroSummary;
  memoryEntries: RetroMemoryEntry[];
  interactionId?: string;
  provenanceHash?: string;
  duplicateProvenance?: boolean;
}

interface RetroDeps {
  repoDir: string;
  db: OrcaDrizzleDB;
  interactionStore: InteractionStore;
  memoryStore: MemoryStore;
  config?: Config;
  registry?: ToolPluginRegistry;
  workflowStore?: WorkflowStore;
  toolOverride?: string;
  modelOverride?: string;
}

export async function runRetro(
  taskID: string,
  deps: RetroDeps,
): Promise<RetroResult> {
  const task = await taskStore.getTask(deps.db, taskID);
  if (!task) throw new Error(`task not found: ${taskID}`);

  const execution = resolveExecution({
    config: deps.config,
    registry: deps.registry,
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
  const runInteraction = await createInteractionRunner({
    config: deps.config,
    registry: deps.registry,
    repoDir: deps.repoDir,
    interactions: deps.interactionStore,
    runTool,
  });

  try {
    const retroSchemaPath =
      deps.workflowStore?.getSystemSchemaPath('retro') ?? undefined;

    const { result, interactionId } = await runInteraction(
      {
        taskId: taskID,
        type: 'retro',
        prompt,
        toolOverride: deps.toolOverride ?? '',
        modelOverride: deps.modelOverride ?? '',
        exitErrorLabel: 'retro',
        jsonSchema: retroSchema,
        schemaPath: retroSchemaPath,
      },
      async (output, context) => {
        const structured = context.runResult.structuredOutput;
        const fromSchema = Array.isArray(structured?.entries)
          ? (structured.entries as RetroMemoryEntry[])
          : Array.isArray(structured)
            ? (structured as RetroMemoryEntry[])
            : null;
        const entries =
          fromSchema ?? extractJSONArray<RetroMemoryEntry>(output) ?? [];
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
        output: JSON.stringify({
          result: 'completed',
          data: {
            entriesCreated: parsed.memoryEntries.length,
            summary: parsed.summary,
          },
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

async function reconstructDiff(
  repoDir: string,
  commitSha?: string,
): Promise<string> {
  if (!commitSha) return '';
  try {
    const result = await gitRun(repoDir, [
      'diff',
      `${commitSha}~1..${commitSha}`,
    ]);
    return result.exitCode === 0 ? result.stdout : '';
  } catch {
    return '';
  }
}

function errorInteractionID(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const id = (error as { interactionId?: unknown }).interactionId;
  if (typeof id !== 'string') return undefined;
  const normalized = id.trim();
  return normalized || undefined;
}

function buildRetroSummary(
  task: Pick<TaskEntry, 'title' | 'status'>,
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
  task: TaskEntry,
): Promise<RetroContext> {
  const interactions = await deps.interactionStore.list(task.id);

  // Reconstruct all diffs from commitSha on-demand
  const planDiffParts: string[] = [];
  for (const ix of interactions.filter((i) => i.type === 'context')) {
    const diff = await reconstructDiff(deps.repoDir, ix.commitSha ?? undefined);
    if (diff) planDiffParts.push(diff);
  }
  const planDiffs = planDiffParts.join('\n---\n');

  const codeDiffs: string[] = [];
  for (const ix of interactions.filter((i) => i.type === 'code')) {
    const diff = await reconstructDiff(deps.repoDir, ix.commitSha ?? undefined);
    if (diff) codeDiffs.push(diff);
  }
  const runDiffs = codeDiffs.join('\n---\n');

  const reviewFeedback = interactions
    .filter((i) => i.type === 'decision' && i.output)
    .map((i) => {
      try {
        const parsed = JSON.parse(i.output!) as {
          data?: { feedback?: string };
        };
        return parsed.data?.feedback?.trim() ?? '';
      } catch {
        return '';
      }
    })
    .filter(Boolean)
    .join('\n---\n');

  const planReviewFeedback = interactions
    .filter((i) => i.output)
    .map((i) => {
      try {
        const parsed = JSON.parse(i.output!) as {
          data?: { feedback?: string };
        };
        const fb = parsed.data?.feedback?.trim() ?? '';
        return fb.toLowerCase().includes('plan') ? fb : '';
      } catch {
        return '';
      }
    })
    .filter(Boolean)
    .join('\n---\n');

  const planInteractions = interactions.filter((i) => i.type === 'context');
  const usedMemoryIDs: string[] = [];
  const usedProvenanceHashes: string[] = [];
  const usedMemoryContent: string[] = [];

  for (const pi of planInteractions) {
    if (!pi.output) continue;
    try {
      const parsed = JSON.parse(pi.output) as {
        result?: string;
        data?: {
          memory?: {
            entries?: Array<{
              id?: string;
              provenanceHash?: string;
              content?: string;
            }>;
          };
          usedMemoryIds?: string[];
        };
      };
      const data = parsed.data ?? {};
      if (data.usedMemoryIds) {
        usedMemoryIDs.push(...data.usedMemoryIds);
      }
      for (const entry of data.memory?.entries ?? []) {
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
  task: TaskEntry,
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
  task: Pick<TaskEntry, 'title'>,
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
