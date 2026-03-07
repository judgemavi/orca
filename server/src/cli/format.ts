import type { StoredInteraction } from '../store/types';
import type { MemoryEntry, Task } from '../types';
import { short, statusIcon } from './helpers';

let jsonMode = false;
let quietMode = false;

export function setJSONMode(enabled: boolean) {
  jsonMode = enabled;
}

export function isJSONMode(): boolean {
  return jsonMode;
}

export function setQuietMode(enabled: boolean) {
  quietMode = enabled;
}

export function isQuietMode(): boolean {
  return quietMode;
}

export function printResult(data: unknown) {
  if (jsonMode) {
    console.log(JSON.stringify({ ok: true, data }));
    return;
  }
  if (quietMode) return;
  console.log(formatHuman(data));
}

export function printError(error: unknown, code = 'ERROR') {
  const message = error instanceof Error ? error.message : String(error);
  if (jsonMode) {
    console.error(JSON.stringify({ ok: false, error: message, code }));
  } else {
    console.error(`error: ${message}`);
  }
}

/** @deprecated use printResult */
export function printJSON(data: unknown) {
  printResult(data);
}

export function printTable(
  rows: Array<Record<string, string | number | boolean | null | undefined>>,
): string {
  if (rows.length === 0) return '(empty)';
  const headers = Object.keys(rows[0] ?? {});
  const widths = headers.map((header) =>
    Math.max(
      header.length,
      ...rows.map((row) => String(row[header] ?? '').length),
    ),
  );

  const head = headers.map((header, i) => pad(header, widths[i]!)).join('  ');
  const line = widths.map((width) => '-'.repeat(width!)).join('  ');
  const body = rows.map((row) =>
    headers
      .map((header, i) => pad(String(row[header] ?? ''), widths[i]!))
      .join('  '),
  );

  return [head, line, ...body].join('\n');
}

function formatHuman(data: unknown): string {
  if (Array.isArray(data) && data.length === 0) {
    return '(empty)';
  }

  if (isTaskArray(data)) {
    return formatTaskList(data);
  }
  if (isTask(data)) {
    return formatTaskDetail(data);
  }

  if (isInteractionArray(data)) {
    return formatInteractionList(data);
  }

  if (isStatusSummary(data)) {
    return formatStatusSummary(data);
  }

  if (isMemoryEntryArray(data)) {
    return formatMemoryList(data);
  }

  if (isActionResult(data)) {
    return formatActionResult(data);
  }

  return JSON.stringify(data, null, 2);
}

function formatTaskList(tasks: Task[]): string {
  const rows = tasks.map((task) => ({
    status: statusIcon(task.status),
    id: short(task.id),
    title: task.title,
    state: task.status,
  }));
  return printTable(rows);
}

function formatTaskDetail(task: Task): string {
  const deps =
    task.dependsOn.length > 0 ? task.dependsOn.map(short).join(', ') : 'none';
  return [
    `Task: ${short(task.id)} — ${task.title}`,
    `Status: ${task.status}`,
    `Dependencies: ${deps}`,
    `Created: ${task.createdAt}`,
    `Updated: ${task.updatedAt}`,
    `Description:`,
    indentBlock(task.description || '(empty)'),
    'Plan:',
    indentBlock((task.plan ?? '').trim() || '(empty)'),
  ].join('\n');
}

function formatInteractionList(interactions: StoredInteraction[]): string {
  const rows = interactions.map((interaction) => ({
    id: short(interaction.id),
    type: interaction.type,
    tool: [interaction.tool, interaction.model].filter(Boolean).join('/'),
    cost: `$${interaction.estimatedCost.toFixed(2)}`,
    status: interaction.status,
  }));
  return printTable(rows);
}

function formatStatusSummary(summary: {
  totalTasks: number;
  byStatus: Record<string, number>;
  runningInteractions: number;
  totalCost: number;
  memory: { totalEntries: number; staleCount: number };
}): string {
  const s = summary.byStatus;
  return [
    `Tasks:  ${s.pending ?? 0} pending · ${s.running ?? 0} running · ${s.approved ?? 0} approved · ${s.failed ?? 0} failed`,
    `Cost:   $${summary.totalCost.toFixed(2)} (${summary.runningInteractions} running interactions)`,
    `Memory: ${summary.memory.totalEntries} entries (${summary.memory.staleCount} stale)`,
  ].join('\n');
}

function formatMemoryList(
  entries: (MemoryEntry & { score?: number })[],
): string {
  const hasScores = entries.some((e) => typeof e.score === 'number');
  const rows = entries.map((entry) => ({
    id: short(entry.id),
    ...(hasScores ? { score: `${Math.round((entry.score ?? 0) * 100)}%` } : {}),
    category: entry.category,
    source: entry.sourceType,
    confidence: entry.confidence.toFixed(2),
    stale: entry.stale ? 'yes' : 'no',
    content: clip(entry.content, 60),
  }));
  return printTable(rows);
}

function formatActionResult(data: Record<string, unknown>): string {
  if (typeof data.deleted === 'string') {
    return `Deleted: ${data.deleted}`;
  }
  if (Array.isArray(data.merged)) {
    const merged = data.merged.length;
    const failed = Array.isArray(data.failed) ? data.failed.length : 0;
    return `Merge completed: ${merged} merged, ${failed} failed`;
  }
  if (typeof data.path === 'string' && typeof data.files === 'number') {
    return `Explore completed: ${data.files} files -> ${data.path}`;
  }
  return JSON.stringify(data, null, 2);
}

function isTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.status === 'string' &&
    Array.isArray(value.dependsOn)
  );
}

function isTaskArray(value: unknown): value is Task[] {
  return Array.isArray(value) && value.every((item) => isTask(item));
}

function isInteraction(value: unknown): value is StoredInteraction {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.type === 'string' &&
    typeof value.tool === 'string' &&
    typeof value.status === 'string' &&
    typeof value.estimatedCost === 'number'
  );
}

function isInteractionArray(value: unknown): value is StoredInteraction[] {
  return Array.isArray(value) && value.every((item) => isInteraction(item));
}

function isStatusSummary(value: unknown): value is {
  totalTasks: number;
  byStatus: Record<string, number>;
  runningInteractions: number;
  totalCost: number;
  memory: { totalEntries: number; staleCount: number };
} {
  if (!isRecord(value)) return false;
  if (typeof value.totalTasks !== 'number') return false;
  if (!isRecord(value.byStatus)) return false;
  if (typeof value.runningInteractions !== 'number') return false;
  if (typeof value.totalCost !== 'number') return false;
  if (!isRecord(value.memory)) return false;
  return (
    typeof value.memory.totalEntries === 'number' &&
    typeof value.memory.staleCount === 'number'
  );
}

function isMemoryEntry(value: unknown): value is MemoryEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.category === 'string' &&
    typeof value.content === 'string'
  );
}

function isMemoryEntryArray(value: unknown): value is MemoryEntry[] {
  return Array.isArray(value) && value.every((item) => isMemoryEntry(item));
}

function isActionResult(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object';
}

function pad(value: string, width: number): string {
  if (value.length >= width) return value;
  return value + ' '.repeat(width - value.length);
}

function indentBlock(value: string): string {
  return value
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}
