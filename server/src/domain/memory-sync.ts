import { createHash } from 'node:crypto';
import type { ToolPluginRegistry } from '../plugin/registry';
import { gitOutput } from '../shared/git';
import { createInteractionRunner } from '../shared/interaction-runner';
import type { InteractionStore } from '../store/interactions';
import type { MemoryStore } from '../store/memory';
import type {
  Config,
  MemoryEntry,
  MemoryRefreshResult,
  MemorySyncResult,
} from '../types';
import { runTool } from '../worker/worker';
import {
  classifyDiffFromGit,
  type DiffChangeType,
  rankFor,
} from './diff-classify';
import { readExploreContext, writeExploreContext } from './explore';
import { extractJSONObject, resolveExecution } from './llm';

export interface MemorySyncStatus {
  lastSyncedCommit: string;
  currentCommit: string;
  syncNeeded: boolean;
  commitsBehind: number;
}

export interface MemoryRefreshOptions {
  config?: Config;
  registry?: ToolPluginRegistry;
  interactions?: InteractionStore;
  toolOverride?: string;
  modelOverride?: string;
  maxDiffBytes?: number;
}

interface RefreshLLMOutput {
  valid?: boolean;
  updatedContent?: string;
  updatedFilePaths?: string[];
}

interface RefreshLLMResult {
  updatedContent: string;
  updatedFilePaths: string[];
  valid: boolean;
}

export interface SyncContextDeps {
  config: Config;
  registry: ToolPluginRegistry;
  interactions: InteractionStore;
}

export async function syncMemoryWithGit(
  repoDir: string,
  memory: MemoryStore,
  contextDeps?: SyncContextDeps,
): Promise<MemorySyncResult> {
  const head = await gitOutput(repoDir, ['rev-parse', 'HEAD']).catch(() => '');
  const currentCommit = head.trim();
  const lastSynced = await memory.getMeta('lastSyncedCommit');

  const staleEntries = await memory.findStaleEntries();
  const result: MemorySyncResult = {
    lastCommit: lastSynced,
    newCommit: currentCommit,
    commitCount: 0,
    affectedFiles: [],
    flaggedEntries: 0,
    staleEntries: staleEntries.length,
    supersededCount: 0,
    classifications: {},
    contextUpdated: false,
    contextStale: staleEntries.length > 0,
  };

  if (!currentCommit) {
    return result;
  }

  if (!lastSynced) {
    await memory.setMeta('lastSyncedCommit', currentCommit);
    result.contextStale = (await memory.findStaleEntries()).length > 0;
    return result;
  }

  if (lastSynced === currentCommit) {
    result.contextStale = (await memory.findStaleEntries()).length > 0;
    return result;
  }

  const commitCountRaw = await gitOutput(repoDir, [
    'rev-list',
    '--count',
    `${lastSynced}..${currentCommit}`,
  ]).catch(() => '0');
  result.commitCount = Number.parseInt(commitCountRaw.trim(), 10) || 0;

  const nameStatus = await gitOutput(repoDir, [
    'diff',
    '--name-status',
    `${lastSynced}..${currentCommit}`,
  ]).catch(() => '');
  const numStat = await gitOutput(repoDir, [
    'diff',
    '--numstat',
    `${lastSynced}..${currentCommit}`,
  ]).catch(() => '');

  const classification = classifyDiffFromGit(nameStatus, numStat);
  const changes = classification.files;

  const affected = new Set<string>();
  const classifications: Record<string, string> = { ...classification.byPath };
  for (const change of changes) {
    if (change.oldPath) {
      affected.add(change.oldPath);
      classifications[change.oldPath] = change.type;
    }
    if (change.newPath) {
      affected.add(change.newPath);
      classifications[change.newPath] = change.type;
    }
    if (change.type === 'renamed' && change.oldPath && change.newPath) {
      await memory.renameFilePathAssociations(change.oldPath, change.newPath);
    }
  }

  const affectedFiles = [...affected].sort((a, b) => a.localeCompare(b));
  result.affectedFiles = affectedFiles;
  result.classifications = classifications;

  const entries = await memory.findByFilePaths(affectedFiles);
  let flagged = 0;
  let superseded = 0;

  for (const entry of entries) {
    const classification = classifyEntry(
      entry.filePaths ?? [],
      classifications,
    );
    if (!classification) continue;
    flagged += 1;

    if (classification === 'deleted') {
      await memory.supersede(entry.id, entry.id);
      superseded += 1;
      continue;
    }
    if (classification === 'major') {
      await memory.decayEntry(entry.id, 0.7);
      await memory.markStale(entry.id);
      await memory.updateCoveredCommit(entry.id, currentCommit);
      continue;
    }
    if (classification === 'medium') {
      await memory.decayEntry(entry.id, 0.85);
      await memory.updateCoveredCommit(entry.id, currentCommit);
      continue;
    }
    if (classification === 'minor') {
      await memory.decayEntry(entry.id, 0.95);
      await memory.updateCoveredCommit(entry.id, currentCommit);
      continue;
    }
    if (classification === 'renamed') {
      await memory.updateCoveredCommit(entry.id, currentCommit);
    }
  }

  // Context patching: update explore_context.md using the syncer's own cursor
  if (contextDeps && lastSynced && lastSynced !== currentCommit) {
    try {
      const patched = await tryPatchExploreContext(
        repoDir,
        lastSynced,
        currentCommit,
        affectedFiles,
        contextDeps,
      );
      result.contextUpdated = patched;
    } catch {
      // Context patching failure should not block sync.
    }
  }

  await memory.setMeta('lastSyncedCommit', currentCommit);

  result.flaggedEntries = flagged;
  result.supersededCount = superseded;
  result.staleEntries = (await memory.findStaleEntries()).length;
  result.contextStale = result.staleEntries > 0;
  return result;
}

export async function refreshMemoryEntries(
  repoDir: string,
  memory: MemoryStore,
  entryID = '',
  options: MemoryRefreshOptions = {},
): Promise<MemoryRefreshResult> {
  const head = await gitOutput(repoDir, ['rev-parse', 'HEAD']).catch(() => '');
  const commit = head.trim();

  if (entryID.trim()) {
    const entry = await memory.get(entryID.trim());
    if (!entry) throw new Error(`memory entry not found: ${entryID}`);
    const updated = await refreshOne(
      repoDir,
      memory,
      entry.id,
      commit,
      options,
    );
    return {
      entryId: entry.id,
      updated: updated ? 1 : 0,
      skipped: updated ? 0 : 1,
      commit,
    };
  }

  const stale = await memory.findStaleEntries();
  let updated = 0;
  let skipped = 0;
  for (const entry of stale) {
    let changed = false;
    try {
      changed = await refreshOne(repoDir, memory, entry.id, commit, options);
    } catch {
      changed = false;
    }
    if (changed) updated += 1;
    else skipped += 1;
  }
  return { updated, skipped, commit };
}

export async function getMemorySyncStatus(
  repoDir: string,
  memory: MemoryStore,
): Promise<MemorySyncStatus> {
  const last = await memory.getMeta('lastSyncedCommit');
  const head = (
    await gitOutput(repoDir, ['rev-parse', 'HEAD']).catch(() => '')
  ).trim();
  const same = Boolean(last) && last === head;

  const commitsBehindRaw =
    !last || same
      ? '0'
      : await gitOutput(repoDir, [
          'rev-list',
          '--count',
          `${last}..${head}`,
        ]).catch(() => '0');

  return {
    lastSyncedCommit: last,
    currentCommit: head,
    syncNeeded: !same,
    commitsBehind: Number.parseInt(commitsBehindRaw.trim(), 10) || 0,
  };
}

const SYNC_PROJECT_SUMMARY_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.go',
  '.py',
  '.rs',
  '.java',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.md',
]);

async function tryPatchExploreContext(
  repoDir: string,
  lastCommit: string,
  headCommit: string,
  changedFiles: string[],
  deps: SyncContextDeps,
): Promise<boolean> {
  // Skip if no code changes in project-relevant files
  const hasCodeChanges = changedFiles.some((f) => {
    const ext = f.slice(f.lastIndexOf('.'));
    return SYNC_PROJECT_SUMMARY_EXTENSIONS.has(ext);
  });
  if (!hasCodeChanges) return false;

  const currentContext = await readExploreContext(repoDir);
  if (!currentContext.trim()) return false;

  const diff = await gitOutput(repoDir, [
    'diff',
    `${lastCommit}..${headCommit}`,
  ]).catch(() => '');
  if (!diff.trim() || diff.length > 200_000) return false;

  const runInteraction = await createInteractionRunner({
    config: deps.config,
    registry: deps.registry,
    repoDir,
    interactions: deps.interactions,
    runTool,
  });

  try {
    const { result: updatedContext } = await runInteraction(
      {
        taskId: null,
        taskRunId: 'sync-context',
        type: 'explore',
        promptName: 'syncContext',
        promptArgs: [
          currentContext.trim(),
          diff.slice(0, 100_000),
          changedFiles.join('\n'),
        ],
        exitErrorLabel: 'sync-context',
      },
      (output) => {
        const trimmed = output.trim();
        if (!trimmed) {
          throw new Error('sync-context produced empty output');
        }
        return trimmed;
      },
    );

    await writeExploreContext(repoDir, `${updatedContext}\n`);

    return true;
  } catch {
    return false;
  }
}

async function refreshOne(
  repoDir: string,
  memory: MemoryStore,
  entryID: string,
  commit: string,
  options: MemoryRefreshOptions,
): Promise<boolean> {
  const entry = await memory.get(entryID);
  if (!entry || !entry.stale) return false;

  const paths = normalizePaths(entry.filePaths ?? []);
  if (paths.length === 0) {
    await memory.update(entry.id, {
      stale: false,
      coveredAtCommit: commit,
      confidence: Math.max(entry.confidence, 0.95),
    });
    return true;
  }

  const existingPaths: string[] = [];
  const deletedPaths: string[] = [];
  for (const path of paths) {
    const exists = await fileExists(repoDir, path);
    if (exists) existingPaths.push(path);
    else deletedPaths.push(path);
  }
  if (deletedPaths.length > 0 && existingPaths.length === 0) {
    await memory.update(entry.id, {
      stale: false,
      coveredAtCommit: commit,
      confidence: Math.min(entry.confidence, 0.1),
    });
    return true;
  }

  const changed = await hasEntryChanges(
    repoDir,
    existingPaths,
    entry.coveredAtCommit ?? '',
    commit,
  );
  if (!changed && deletedPaths.length === 0) {
    await memory.update(entry.id, {
      stale: false,
      coveredAtCommit: commit,
      confidence: Math.max(entry.confidence, 0.95),
    });
    return true;
  }

  const execution = resolveExecution({
    config: options.config,
    registry: options.registry,
    toolOverride: options.toolOverride ?? '',
    modelOverride: options.modelOverride ?? '',
    interactionType: 'explore',
  });
  if (!execution) {
    return false;
  }

  const llmResult = await refreshEntryWithLLM(
    repoDir,
    entry,
    commit,
    existingPaths,
    options,
  );
  if (llmResult.valid || !llmResult.updatedContent) {
    await memory.update(entry.id, {
      stale: false,
      coveredAtCommit: commit,
      confidence:
        deletedPaths.length > 0
          ? Math.min(entry.confidence, 0.2)
          : Math.max(entry.confidence, 0.95),
    });
    return true;
  }

  const nextFilePaths =
    llmResult.updatedFilePaths.length > 0
      ? llmResult.updatedFilePaths
      : existingPaths;
  const nextConfidence =
    entry.confidence > 0 ? Math.min(1, entry.confidence) : 0.95;
  const replacement = await memory.create({
    content: llmResult.updatedContent.trim(),
    category: entry.category,
    tags: entry.tags,
    sourceTaskId: entry.sourceTaskId,
    sourceInteractionId: entry.sourceInteractionId,
    sourceType: entry.sourceType,
    filePaths: nextFilePaths,
    coveredAtCommit: commit,
    confidence: nextConfidence,
    provenanceHash: refreshProvenanceHash(
      entry,
      llmResult.updatedContent,
      commit,
    ),
  });
  await memory.supersede(entry.id, replacement.id);
  return true;
}

async function refreshEntryWithLLM(
  repoDir: string,
  entry: MemoryEntry,
  commit: string,
  existingPaths: string[],
  options: MemoryRefreshOptions,
): Promise<RefreshLLMResult> {
  const base = (entry.coveredAtCommit ?? '').trim() || commit;
  const diff = await buildRefreshDiff(repoDir, base, commit, existingPaths);
  const maxDiffBytes = options.maxDiffBytes ?? 200_000;
  if (maxDiffBytes > 0 && diff.length > maxDiffBytes) {
    return { valid: true, updatedContent: '', updatedFilePaths: [] };
  }

  const currentFileContent = await collectCurrentFileContent(
    repoDir,
    existingPaths,
    maxDiffBytes,
  );
  const prompt = buildRefreshPrompt(entry, diff, currentFileContent);
  const runInteraction = await createInteractionRunner({
    config: options.config,
    registry: options.registry,
    repoDir,
    interactions: options.interactions,
    runTool,
  });

  const { result: llmResult } = await runInteraction(
    {
      taskId: entry.sourceTaskId ?? null,
      taskRunId: `memory-refresh-${entry.id.slice(0, 8)}`,
      type: 'explore',
      prompt,
      toolOverride: options.toolOverride ?? '',
      modelOverride: options.modelOverride ?? '',
      exitErrorLabel: 'memory refresh',
    },
    (output) => {
      const payload = extractJSONObject<RefreshLLMOutput>(output);
      if (!payload) {
        throw new Error('failed to parse memory refresh JSON output');
      }
      return {
        valid: Boolean(payload.valid),
        updatedContent: String(payload.updatedContent ?? '').trim(),
        updatedFilePaths: normalizePaths(payload.updatedFilePaths ?? []),
      };
    },
    (parsed) => ({
      qualityJson: JSON.stringify({
        memoryEntryId: entry.id,
        valid: parsed.valid,
        updatedFilePaths: parsed.updatedFilePaths,
      }),
    }),
  );

  return llmResult;
}

async function hasEntryChanges(
  repoDir: string,
  filePaths: string[],
  baseCommit: string,
  headCommit: string,
): Promise<boolean> {
  const base = baseCommit.trim();
  const head = headCommit.trim();
  if (!base || !head || base === head || filePaths.length === 0) {
    return false;
  }

  const args = ['diff', '--name-only', `${base}..${head}`, '--', ...filePaths];
  const changedRaw = await gitOutput(repoDir, args).catch(() => '');
  return Boolean(changedRaw.trim());
}

async function buildRefreshDiff(
  repoDir: string,
  baseCommit: string,
  headCommit: string,
  filePaths: string[],
): Promise<string> {
  const base = baseCommit.trim();
  const head = headCommit.trim();
  if (!base || !head || base === head || filePaths.length === 0) {
    return '';
  }
  const args = ['diff', `${base}..${head}`, '--', ...filePaths];
  return gitOutput(repoDir, args).catch(() => '');
}

async function collectCurrentFileContent(
  repoDir: string,
  filePaths: string[],
  maxDiffBytes: number,
): Promise<string> {
  const blocks: string[] = [];
  for (const path of normalizePaths(filePaths)) {
    const content = await gitOutput(repoDir, ['show', `HEAD:${path}`]).catch(
      async () =>
        Bun.file(`${repoDir}/${path}`)
          .text()
          .catch(() => ''),
    );
    if (!content.trim()) continue;
    const maxFileBytes = maxDiffBytes > 0 ? Math.floor(maxDiffBytes / 2) : 0;
    const trimmed = maxFileBytes > 0 ? content.slice(0, maxFileBytes) : content;
    blocks.push(`### ${path}\n${trimmed.trim()}`);
  }
  return blocks.join('\n\n').trim();
}

function buildRefreshPrompt(
  entry: MemoryEntry,
  diff: string,
  currentFileContent: string,
): string {
  const entryPayload = JSON.stringify(
    {
      content: entry.content.trim(),
      category: entry.category.trim(),
      sourceType: entry.sourceType.trim(),
      filePaths: normalizePaths(entry.filePaths ?? []),
    },
    null,
    2,
  );

  return [
    'You are refreshing a stale memory entry.',
    '',
    'Return valid JSON only with this schema:',
    '{',
    '  "valid": boolean,',
    '  "updatedContent": string,',
    '  "updatedFilePaths": string[]',
    '}',
    '',
    'Rules:',
    '- If the entry is still accurate, return {"valid": true, "updatedContent": "", "updatedFilePaths": []}.',
    '- If outdated, return {"valid": false, ...} with concise updated content.',
    '- Keep content self-contained and specific to this codebase.',
    '- Use repo-relative file paths only.',
    '',
    'Current entry:',
    entryPayload,
    '',
    'Diff since entry was covered:',
    emptyIfBlank(diff),
    '',
    'Current file content:',
    emptyIfBlank(currentFileContent),
  ].join('\n');
}

function refreshProvenanceHash(
  entry: MemoryEntry,
  updatedContent: string,
  commit: string,
): string {
  return createHash('sha256')
    .update(
      [entry.provenanceHash.trim(), updatedContent.trim(), commit.trim()].join(
        '\n---\n',
      ),
    )
    .digest('hex');
}

async function fileExists(repoDir: string, filePath: string): Promise<boolean> {
  return Bun.file(`${repoDir}/${filePath}`).exists();
}

function normalizePaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => path.trim()).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b),
  );
}

function emptyIfBlank(value: string): string {
  const trimmed = value.trim();
  return trimmed || '(none)';
}

function classifyEntry(
  paths: string[],
  classifications: Record<string, string>,
): DiffChangeType | '' {
  let rank = 0;
  let best: DiffChangeType | '' = '';
  for (const path of paths) {
    const cls = classifications[path] as DiffChangeType | undefined;
    if (!cls) continue;
    const nextRank = rankFor(cls);
    if (nextRank > rank) {
      rank = nextRank;
      best = cls;
    }
  }
  return best;
}
