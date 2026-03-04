import { createHash } from 'node:crypto';
import type { DriverRegistry } from '../driver/registry';
import { loadPrompt } from '../prompts/loader';
import { gitOutput, gitRun } from '../shared/git';
import { createPhaseRunner } from '../shared/phase-runner';
import type { InteractionStore } from '../store/interactions';
import type { MemoryStore } from '../store/memory';
import type { Config, MemoryCategory } from '../types';
import { Phase } from '../types';
import { runTool } from '../worker/worker';
import { extractJSONArray } from './llm';

const MEMORY_MARKER = '## Memory Extraction';
const ALLOWED_EXPLORE_CATEGORIES = new Set<MemoryCategory>([
  'architecture',
  'dependency',
  'pattern',
  'convention',
]);

interface ExtractedMemoryEntry {
  content?: string;
  category?: string;
  tags?: string[];
  confidence?: number;
  filePaths?: string[];
}

export interface RunExploreInput {
  repoDir: string;
  interactions: InteractionStore;
  memory: MemoryStore;
  config: Config;
  registry: DriverRegistry;
  query?: string;
  toolOverride?: string;
  modelOverride?: string;
}

export interface RunExploreResult {
  path: string;
  files: number;
  interactionId: string;
  tool: string;
  model: string;
  context: string;
  seeded: number;
}

export function exploreContextPath(repoDir: string): string {
  return `${repoDir}/.orca/explore_context.md`;
}

export async function listTrackedFiles(repoDir: string): Promise<string[]> {
  const result = await gitRun(repoDir, ['ls-files']);
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function buildExploreContext(
  files: string[],
  timestamp = new Date().toISOString(),
): string {
  return [
    '# Explore Context',
    '',
    `Generated: ${timestamp}`,
    '',
    `Tracked files scanned: ${files.length}`,
    '',
    'Top files:',
    ...files.slice(0, 50).map((file) => `- ${file}`),
  ].join('\n');
}

export async function runExplore(
  input: RunExploreInput,
): Promise<RunExploreResult> {
  const trackedFiles = await listTrackedFiles(input.repoDir);
  const runPhase = await createPhaseRunner({
    config: input.config,
    registry: input.registry,
    repoDir: input.repoDir,
    interactions: input.interactions,
    runTool,
  });

  const prompt = await buildExplorePrompt(
    input.repoDir,
    trackedFiles,
    input.query ?? '',
    input.memory,
  );

  const { result, interactionId, tool, model } = await runPhase(
    {
      taskId: null,
      taskRunId: 'explore',
      phase: Phase.explore,
      prompt,
      toolOverride: input.toolOverride ?? '',
      modelOverride: input.modelOverride ?? '',
      resolveErrorMessage: 'unable to resolve explore tool/model',
      exitErrorLabel: 'explore',
    },
    async (output) => {
      if (!output.trim()) {
        throw new Error('explore produced empty output');
      }
      const context = stripMemoryExtractionSection(output);
      const extracted = parseExtractedMemoryEntries(output);
      const path = await writeExploreContext(input.repoDir, `${context}\n`);
      const seeded = await seedExploreMemory(
        input.repoDir,
        input.memory,
        context,
        extracted,
      );
      return { context, path, seeded };
    },
    (parsed) => ({
      qualityJson: JSON.stringify({
        files: trackedFiles.length,
        seeded: parsed.seeded,
        context_path: parsed.path,
      }),
    }),
  );

  return {
    path: result.path,
    files: trackedFiles.length,
    interactionId: interactionId,
    tool,
    model,
    context: result.context,
    seeded: result.seeded,
  };
}

export async function readExploreContext(repoDir: string): Promise<string> {
  return Bun.file(exploreContextPath(repoDir))
    .text()
    .catch(() => '');
}

export async function writeExploreContext(
  repoDir: string,
  content: string,
): Promise<string> {
  const path = exploreContextPath(repoDir);
  await Bun.$`mkdir -p ${repoDir}/.orca`;
  await Bun.write(path, content);
  return path;
}

async function buildExplorePrompt(
  repoDir: string,
  trackedFiles: string[],
  query: string,
  memory: MemoryStore,
): Promise<string> {
  const template = await loadPrompt(repoDir, 'explore');
  const filesSection =
    trackedFiles.length === 0
      ? '(none)'
      : trackedFiles
          .slice(0, 4_000)
          .map((file) => `- ${file}`)
          .join('\n');

  const parts = [template.trim()];
  parts.push(`## Tracked Files\n\n${filesSection}`);

  const memorySection = buildExistingMemorySection(await memory.list());
  if (memorySection) {
    parts.push(`## Existing Project Memory\n\n${memorySection}`);
  }

  const goal = query.trim();
  if (goal) {
    parts.push(`## User Goal\n\n${goal}`);
    parts.push(
      'Incorporate the goal into your analysis by calling out what already supports it and what is missing.',
    );
  }

  return parts.join('\n\n');
}

function buildExistingMemorySection(
  entries: Awaited<ReturnType<MemoryStore['list']>>,
): string {
  if (entries.length === 0) return '';
  const max = Math.min(entries.length, 40);
  const lines: string[] = [];
  for (let i = 0; i < max; i += 1) {
    const entry = entries[i];
    lines.push(`- [${entry.category}] ${entry.content.trim()}`);
    if (entry.filePaths?.length) {
      lines.push(`  files: ${entry.filePaths.join(', ')}`);
    }
  }
  return lines.join('\n').trim();
}

function parseExtractedMemoryEntries(output: string): ExtractedMemoryEntry[] {
  const section = memoryExtractionSection(output);
  if (!section) return [];
  return extractJSONArray<ExtractedMemoryEntry>(section) ?? [];
}

function stripMemoryExtractionSection(output: string): string {
  const lower = output.toLowerCase();
  const marker = MEMORY_MARKER.toLowerCase();
  const idx = lower.lastIndexOf(marker);
  if (idx === -1) return output.trim();
  return output.slice(0, idx).trim();
}

function memoryExtractionSection(output: string): string {
  const lower = output.toLowerCase();
  const marker = MEMORY_MARKER.toLowerCase();
  const idx = lower.lastIndexOf(marker);
  if (idx === -1) return '';
  return output.slice(idx + MEMORY_MARKER.length).trim();
}

async function seedExploreMemory(
  repoDir: string,
  memory: MemoryStore,
  contextContent: string,
  extracted: ExtractedMemoryEntry[],
): Promise<number> {
  const tracked = new Set(await listTrackedFiles(repoDir));
  const coveredAtCommit = await gitOutput(repoDir, ['rev-parse', 'HEAD']).catch(
    () => '',
  );
  let seeded = 0;

  const existingSummaries = await memory.list({ tag: 'project-summary' });
  const existingSeeds = await memory.list({ tag: 'explore-seed' });

  const summary = buildProjectSummary(contextContent);
  let summaryID = '';
  if (summary) {
    const provenanceHash = hashProjectSummary(contextContent, summary);
    const duplicate = await memory.getByProvenanceHash(provenanceHash);
    if (duplicate && !duplicate.supersededBy) {
      summaryID = duplicate.id;
      await memory.update(summaryID, {
        stale: false,
        coveredAtCommit: coveredAtCommit,
        confidence: Math.max(duplicate.confidence, 0.95),
      });
    } else {
      const created = await memory.create({
        content: summary,
        category: 'architecture',
        tags: ['project-summary'],
        sourceType: 'explore',
        coveredAtCommit: coveredAtCommit,
        confidence: 0.95,
        provenanceHash: provenanceHash,
      });
      summaryID = created.id;
      seeded += 1;
    }
  }

  const createdSeedIDs: string[] = [];
  for (const row of extracted) {
    const content = String(row.content ?? '').trim();
    const category = normalizeCategory(row.category);
    if (!content || !category) continue;

    const filePaths = filterTrackedFilePaths(row.filePaths ?? [], tracked);
    const provenanceHash = hashExploreSeed(
      contextContent,
      content,
      category,
      filePaths,
    );
    if (await memory.hasProvenanceHash(provenanceHash)) continue;

    const confidenceRaw = Number(row.confidence ?? 0);
    const confidence =
      Number.isFinite(confidenceRaw) && confidenceRaw > 0
        ? Math.min(1, confidenceRaw)
        : 0.95;

    const created = await memory.create({
      content,
      category,
      tags: normalizeStrings([...(row.tags ?? []), 'explore-seed']),
      sourceType: 'explore',
      filePaths: filePaths,
      coveredAtCommit: coveredAtCommit,
      confidence,
      provenanceHash: provenanceHash,
    });
    createdSeedIDs.push(created.id);
    seeded += 1;
  }

  if (summaryID) {
    for (const existing of existingSummaries) {
      if (existing.id === summaryID) continue;
      await memory.supersede(existing.id, summaryID);
    }
  }

  const replacementSeedID = createdSeedIDs[0] ?? summaryID;
  if (replacementSeedID) {
    for (const existing of existingSeeds) {
      if (existing.id === replacementSeedID) continue;
      await memory.supersede(existing.id, replacementSeedID);
    }
  }

  return seeded;
}

function buildProjectSummary(contextContent: string): string {
  const out: string[] = [];
  for (const line of contextContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.toLowerCase().startsWith(MEMORY_MARKER.toLowerCase())) break;
    out.push(trimmed);
    if (out.length >= 10) break;
  }
  return out.join('\n').trim();
}

function normalizeCategory(raw: unknown): MemoryCategory | '' {
  const value = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!value) return '';
  return ALLOWED_EXPLORE_CATEGORIES.has(value as MemoryCategory)
    ? (value as MemoryCategory)
    : '';
}

function filterTrackedFilePaths(
  paths: string[],
  tracked: Set<string>,
): string[] {
  if (tracked.size === 0 || paths.length === 0) return [];
  return normalizeStrings(paths).filter((path) => tracked.has(path));
}

function normalizeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b),
  );
}

function hashProjectSummary(contextContent: string, summary: string): string {
  return createHash('sha256')
    .update(
      [contextContent.trim(), summary.trim(), 'project-summary'].join(
        '\n---\n',
      ),
    )
    .digest('hex');
}

function hashExploreSeed(
  contextContent: string,
  content: string,
  category: string,
  filePaths: string[],
): string {
  return createHash('sha256')
    .update(
      [
        contextContent.trim(),
        content.trim(),
        category.trim(),
        normalizeStrings(filePaths).join(','),
      ].join('\n---\n'),
    )
    .digest('hex');
}
