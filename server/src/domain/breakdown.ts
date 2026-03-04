import type { DriverRegistry } from '../driver/registry';
import { createPhaseRunner } from '../shared/phase-runner';
import type { InteractionStore } from '../store/interactions';
import type { Config, ProposedTask } from '../types';
import { PHASES } from '../types';
import { runTool } from '../worker/worker';
import { extractJSONArray } from './llm';

const TASK_HEADER_RE = /^###\s*task\s+\d+(?::\s*(.*))?$/i;
const FIELD_RE = /^-+\s*([A-Za-z ]+)\s*:\s*(.*)$/;

export interface RunBreakdownInput {
  repoDir: string;
  config: Config;
  registry: DriverRegistry;
  interactions: InteractionStore;
  goal: string;
  taskID?: string;
  memoryContext?: string;
  toolOverride?: string;
  modelOverride?: string;
}

export interface RunBreakdownResult {
  proposed: ProposedTask[];
  interactionId: string;
  tool: string;
  model: string;
}

export function generateProposedSubtasks(
  title: string,
  description: string,
): ProposedTask[] {
  const base = title.trim() || 'Task';
  const context = description.trim();

  return [
    {
      title: `${base}: analysis`,
      description:
        `Analyze existing code paths and constraints.\n\n${context}`.trim(),
      dependsOnIndices: [],
      suggestedTool: 'claude',
    },
    {
      title: `${base}: implementation`,
      description: 'Implement focused code changes based on the analysis.',
      dependsOnIndices: [0],
      suggestedTool: 'claude',
    },
    {
      title: `${base}: validation`,
      description: 'Run targeted verification and prepare for review.',
      dependsOnIndices: [1],
      suggestedTool: 'claude',
    },
  ];
}

export async function runBreakdown(
  input: RunBreakdownInput,
): Promise<RunBreakdownResult> {
  const runPhase = await createPhaseRunner({
    config: input.config,
    registry: input.registry,
    repoDir: input.repoDir,
    interactions: input.interactions,
    runTool,
  });

  const contextSection = input.memoryContext?.trim()
    ? `## Retrieved Context\n\n${input.memoryContext.trim()}\n`
    : '';

  const {
    result: proposed,
    interactionId,
    tool,
    model,
  } = await runPhase(
    {
      taskId: input.taskID?.trim() || null,
      taskRunId: input.taskID?.trim() || 'breakdown',
      phase: PHASES.breakdown,
      resolvePhase: PHASES.plan,
      promptName: 'breakdown',
      promptArgs: [contextSection, input.goal.trim()],
      toolOverride: input.toolOverride ?? '',
      modelOverride: input.modelOverride ?? '',
      resolveErrorMessage: 'unable to resolve breakdown tool/model',
      exitErrorLabel: 'breakdown',
    },
    (output) => {
      const parsed = parseProposedTasks(output);
      if (parsed.length === 0) {
        throw new Error('no subtasks found in breakdown output');
      }
      return parsed;
    },
    (parsed) => ({
      qualityJson: JSON.stringify({ goal: input.goal, proposed: parsed }),
    }),
  );

  return {
    proposed,
    interactionId,
    tool,
    model,
  };
}

export function normalizeProposedTasks(tasks: ProposedTask[]): ProposedTask[] {
  return tasks.map((task) => ({
    title: task.title?.trim() || 'Untitled task',
    description: task.description?.trim() || '',
    dependsOnIndices: Array.isArray(task.dependsOnIndices)
      ? task.dependsOnIndices.filter(
          (index) => Number.isInteger(index) && index >= 0,
        )
      : [],
    suggestedTool: task.suggestedTool?.trim() || 'claude',
  }));
}

function parseProposedTasks(output: string): ProposedTask[] {
  const parsedJSON = extractJSONArray<ProposedTask>(output);
  if (parsedJSON && parsedJSON.length > 0) {
    return normalizeProposedTasks(parsedJSON);
  }

  const lines = output.trim().split('\n');
  if (lines.length === 0) return [];

  const tasks: ProposedTask[] = [];
  let current: ProposedTask | null = null;

  const pushCurrent = () => {
    if (!current) return;
    if (!current.title.trim() && !current.description.trim()) {
      current = null;
      return;
    }
    tasks.push(current);
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const headerMatch = line.match(TASK_HEADER_RE);
    if (headerMatch) {
      pushCurrent();
      current = {
        title: String(headerMatch[1] ?? '').trim(),
        description: '',
        dependsOnIndices: [],
        suggestedTool: 'claude',
      };
      continue;
    }
    if (!current) continue;

    const fieldMatch = line.match(FIELD_RE);
    if (!fieldMatch) continue;

    const key = String(fieldMatch[1] ?? '')
      .trim()
      .toLowerCase();
    const value = String(fieldMatch[2] ?? '').trim();
    if (key === 'title') {
      current.title = value;
      continue;
    }
    if (key === 'description') {
      current.description = value;
      continue;
    }
    if (key === 'depends on') {
      current.dependsOnIndices = parseDependsOnNumbers(value);
      continue;
    }
    if (key === 'suggested tool') {
      current.suggestedTool =
        normalizeSuggestedTool(value) || current.suggestedTool;
    }
  }
  pushCurrent();

  return normalizeProposedTasks(tasks);
}

function parseDependsOnNumbers(raw: string): number[] {
  const cleaned = raw.trim().toLowerCase();
  if (!cleaned || cleaned === 'none' || cleaned === 'n/a') return [];

  return [
    ...new Set(
      cleaned
        .split(/[,\s;]+/g)
        .map((part) => Number.parseInt(part.trim(), 10))
        .filter((value) => Number.isFinite(value) && value > 0)
        .map((value) => value - 1),
    ),
  ];
}

function normalizeSuggestedTool(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (value === 'claude' || value === 'codex') return value;
  if (value === 'none') return '';
  return '';
}
