import type { TaskStatus } from '@orca/types';
import { resolveModel, resolveTool } from '../config/config';
import type { Config } from '../db/schema';
import type { ToolPluginRegistry } from '../plugin/registry';
import { toolDefinition } from '../plugin/registry';
import type {
  HeadlessOpts,
  ToolPlugin,
  ToolPluginEvent,
} from '../plugin/types';
import { loadPrompt } from '../prompts/loader';
import { gitRun } from '../shared/git';
import { runTool, type WorkerOutputLine } from '../worker/worker';
import { evaluateTaskOutcome } from './results';

interface ResolvedTaskExecution {
  toolName: string;
  plugin: ToolPlugin;
  model: string;
}

interface TaskRunInput {
  taskID: string;
  interactionType: string;
  title: string;
  description: string;
  context?: string;
  cwd: string;
  worktreePath: string;
  logsDir: string;
  repoDir?: string;
  baseBranch: string;
  toolName: string;
  plugin: ToolPlugin;
  model: string;
  interactionLogPath?: string;
  resumeSessionID?: string;
  feedback?: string;
  headlessOpts?: HeadlessOpts;
  signal?: AbortSignal;
  onOutputLine?: (line: WorkerOutputLine) => void | Promise<void>;
}

export interface TaskRunResult {
  taskID: string;
  interactionType: string;
  toolName: string;
  model: string;
  status: TaskStatus;
  interactionStatus: 'completed' | 'failed';
  exitCode: number;
  signalCode: string | number | null;
  sessionID: string;
  events: ToolPluginEvent[];
  logPath: string;
  durationMS: number;
  timedOut: boolean;
  aborted: boolean;
  diff: string;
  filesChanged: string[];
  commitSha?: string;
  error?: string;
}

export function resolveTaskExecution(
  config: Config,
  registry: ToolPluginRegistry,
  toolOverride: string,
  modelOverride: string,
): ResolvedTaskExecution {
  const toolName = resolveTool(config, toolOverride);
  const plugin = toolDefinition(registry, toolName);
  if (!plugin) {
    throw new Error(`tool not available: ${toolName}`);
  }

  const model = resolveModel(config, registry, toolName, modelOverride);
  if (!model.trim()) {
    throw new Error(
      `model could not be resolved for tool ${JSON.stringify(toolName)}`,
    );
  }

  return { toolName, plugin, model };
}

export async function runTask(input: TaskRunInput): Promise<TaskRunResult> {
  const prompt = await buildPrompt(input);

  const result = await runTool({
    taskID: input.taskID,
    driverName: input.toolName,
    plugin: input.plugin,
    prompt,
    model: input.model,
    dir: input.worktreePath,
    resumeSessionID: input.resumeSessionID,
    feedback: input.feedback,
    headlessOpts: input.headlessOpts,
    cwd: input.cwd,
    logsDir: input.logsDir,
    logPath: input.interactionLogPath,
    signal: input.signal,
    onLine: input.onOutputLine,
  });

  const diff = await gitOutput(input.worktreePath, [
    'diff',
    input.baseBranch,
  ]).catch(() => '');
  const filesChangedRaw = await gitOutput(input.worktreePath, [
    'diff',
    '--name-only',
    input.baseBranch,
  ]).catch(() => '');

  const outputTail = await readTail(result.logPath, 8_000);
  const outcome = evaluateTaskOutcome({
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    aborted: result.aborted,
    diff,
    outputTail,
    workerError: result.error,
  });

  return {
    taskID: input.taskID,
    interactionType: input.interactionType,
    toolName: input.toolName,
    model: input.model,
    status: outcome.taskStatus,
    interactionStatus: outcome.interactionStatus,
    exitCode: result.exitCode,
    signalCode: result.signalCode,
    sessionID: result.sessionID,
    events: result.events,
    logPath: result.logPath,
    durationMS: result.durationMS,
    timedOut: result.timedOut,
    aborted: result.aborted,
    diff,
    filesChanged: normalizeList(filesChangedRaw.split('\n')),
    commitSha: result.commitSha || undefined,
    error: outcome.error,
  };
}

async function buildPrompt(
  input: Pick<
    TaskRunInput,
    | 'title'
    | 'description'
    | 'context'
    | 'feedback'
    | 'resumeSessionID'
    | 'repoDir'
    | 'cwd'
  >,
): Promise<string> {
  const repoDir = input.repoDir ?? '';
  if (!repoDir) throw new Error('repoDir is required for prompt loading');
  const executorStyle = await loadPrompt(repoDir, 'executorStyle');

  const parts: string[] = [];

  if (executorStyle.trim()) parts.push(executorStyle.trim());
  if (input.context?.trim()) parts.push(input.context.trim());

  const taskCore = [input.title.trim(), input.description.trim()]
    .filter(Boolean)
    .join('\n\n');
  if (taskCore) parts.push(`## Task\n\n${taskCore}`);

  if (input.repoDir && input.cwd && input.cwd !== input.repoDir) {
    parts.push(
      `## Working Directory\n\nYour repo root is \`${input.cwd}\` (a git worktree). ` +
        `Use relative paths or paths under this directory. ` +
        `Do NOT reference \`${input.repoDir}\` directly.`,
    );
  }

  if (!input.resumeSessionID?.trim() && input.feedback?.trim()) {
    parts.push(`## Reviewer Feedback\n\n${input.feedback.trim()}`);
  }

  return parts.join('\n\n---\n\n');
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const { stdout, stderr, exitCode } = await gitRun(cwd, args);
  if (exitCode !== 0) {
    const message =
      stderr || `git ${args.join(' ')} failed with exit code ${exitCode}`;
    throw new Error(message);
  }
  return stdout;
}

async function readTail(path: string, maxBytes: number): Promise<string> {
  const text = await Bun.file(path)
    .text()
    .catch(() => '');
  if (text.length <= maxBytes) return text;
  return text.slice(-maxBytes);
}

function normalizeList(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }

  return out;
}
