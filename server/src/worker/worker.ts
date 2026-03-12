import type {
  HeadlessOpts,
  ToolPlugin,
  ToolPluginEvent,
} from '../plugin/types';
import { toErrorMessage } from '../shared/errors';
import { gitOutput } from '../shared/git';
import { log } from '../shared/logger';
import { trackProcess, untrackProcess } from '../shared/process-registry';

export interface WorkerOutputLine {
  stream: 'stdout' | 'stderr';
  line: string;
  ts: string;
}

interface WorkerRunOptions {
  taskID: string;
  driverName: string;
  plugin: ToolPlugin;
  prompt: string;
  model: string;
  dir: string;
  resumeSessionID?: string;
  feedback?: string;
  headlessOpts?: HeadlessOpts;
  timeoutMS?: number;
  cwd: string;
  logsDir: string;
  logPath?: string;
  signal?: AbortSignal;
  onLine?: (line: WorkerOutputLine) => void | Promise<void>;
  onEvent?: (event: ToolPluginEvent) => void | Promise<void>;
}

export interface WorkerRunResult {
  exitCode: number;
  signalCode: string | number | null;
  sessionID: string;
  events: ToolPluginEvent[];
  diff: string;
  filesChanged: string[];
  commitSha: string;
  logPath: string;
  durationMS: number;
  timedOut: boolean;
  aborted: boolean;
  error?: string;
  structuredOutput?: Record<string, unknown>;
}

export async function runTool(
  options: WorkerRunOptions,
): Promise<WorkerRunResult> {
  const logPath =
    options.logPath?.trim() ||
    `${options.logsDir}/${options.taskID}.${Date.now()}.log`;
  const resumeSession = (options.resumeSessionID ?? '').trim();
  const args = resumeSession
    ? await options.plugin.resumeArgs(
        resumeSession,
        options.feedback ?? '',
        options.model,
        options.dir,
        options.headlessOpts,
      )
    : await options.plugin.headlessArgs(
        options.prompt,
        options.model,
        options.dir,
        options.headlessOpts,
      );
  const timeoutMS = options.timeoutMS ?? 10 * 60_000;

  await Bun.$`mkdir -p ${dirName(logPath)}`;

  const cmd = [options.plugin.binary(), ...args];
  log.info('spawning tool', {
    taskId: options.taskID,
    tool: options.driverName,
    model: options.model,
    promptLength: options.prompt.length,
    schemaPath: options.headlessOpts?.schemaPath ?? null,
    cwd: options.cwd,
  });

  const child = Bun.spawn({
    cmd,
    cwd: options.cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: filteredEnv(process.env),
  });
  trackProcess(child, `run:${options.taskID}`);

  const writer = Bun.file(logPath).writer();
  let writeQueue = Promise.resolve();
  let writeError = '';
  const queueWrite = (text: string) => {
    if (!text) return;
    writeQueue = writeQueue.then(async () => {
      try {
        await writer.write(text);
      } catch (error) {
        writeError = toErrorMessage(error);
      }
    });
  };

  let sessionID = '';
  const events: ToolPluginEvent[] = [];
  const emitLine = (stream: 'stdout' | 'stderr', line: string) => {
    const value = line.replace(/\r$/, '');
    if (stream === 'stdout') {
      const event = options.plugin.parseEvent(Buffer.from(value));
      if (event) {
        events.push(event);
        if (event.type === 'session' && event.sessionID?.trim()) {
          sessionID = event.sessionID.trim();
        }
        if (options.onEvent) {
          void Promise.resolve(options.onEvent(event)).catch(() => {});
        }
      }
    } else if (value.trim()) {
      const event: ToolPluginEvent = { type: 'error', text: value, raw: value };
      events.push(event);
      if (options.onEvent) {
        void Promise.resolve(options.onEvent(event)).catch(() => {});
      }
    }
    if (options.onLine) {
      void Promise.resolve(
        options.onLine({
          stream,
          line: value,
          ts: new Date().toISOString(),
        }),
      ).catch(() => {});
    }
  };

  let timedOut = false;
  let aborted = false;

  const abort = () => {
    aborted = true;
    try {
      child.kill();
    } catch {
      // Already exited.
    }
  };

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    try {
      child.kill();
    } catch {
      // Already exited.
    }
  }, timeoutMS);

  let removeAbortListener: (() => void) | undefined;
  if (options.signal) {
    if (options.signal.aborted) {
      abort();
    } else {
      const onAbort = () => abort();
      options.signal.addEventListener('abort', onAbort);
      removeAbortListener = () =>
        options.signal?.removeEventListener('abort', onAbort);
    }
  }

  const start = Date.now();

  await Promise.all([
    consumeStream(child.stdout, 'stdout', queueWrite, emitLine),
    consumeStream(child.stderr, 'stderr', queueWrite, emitLine),
  ]);

  const exitCode = await child.exited;
  untrackProcess(child);

  clearTimeout(timeoutHandle);
  removeAbortListener?.();

  await writeQueue;
  try {
    await writer.flush();
  } catch {
    // Ignore flush errors and attempt close anyway.
  }
  try {
    await writer.end();
  } catch {
    // Ignore close errors.
  }

  const error = buildWorkerError({
    aborted,
    timedOut,
    timeoutMS,
    writeError,
    exitCode,
  });
  if (!sessionID) {
    sessionID = options.plugin.parseSessionID(events) ?? '';
  }

  log.info('tool exited', {
    taskId: options.taskID,
    tool: options.driverName,
    exitCode,
    durationMs: Date.now() - start,
    timedOut,
    aborted,
    ...(error ? { error } : {}),
  });

  // Extract structured output when JSON schema was requested.
  // Claude: single JSON response with { structured_output: {...} } envelope.
  // Codex: streaming events where the last agent_message text IS the schema-conformant JSON.
  let structuredOutput: Record<string, unknown> | undefined;
  const hasSchema =
    options.headlessOpts?.jsonSchema || options.headlessOpts?.schemaPath;
  if (hasSchema && events.length > 0) {
    const textEvents = events.filter((e) => e.type === 'text');
    const fullText = textEvents.map((e) => e.text ?? '').join('');
    try {
      const jsonResponse = JSON.parse(fullText) as Record<string, unknown>;
      // Claude envelope: { structured_output, session_id, usage, ... }
      if (
        jsonResponse.structured_output &&
        typeof jsonResponse.structured_output === 'object'
      ) {
        structuredOutput = jsonResponse.structured_output as Record<
          string,
          unknown
        >;
      }
      if (!sessionID && typeof jsonResponse.session_id === 'string') {
        sessionID = jsonResponse.session_id;
      }
    } catch {
      // Fall through — events already captured text
    }

    // Codex: last text event is the schema-conformant JSON directly
    if (!structuredOutput && textEvents.length > 0) {
      const lastText = (textEvents[textEvents.length - 1]!.text ?? '').trim();
      try {
        const parsed = JSON.parse(lastText) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object') {
          structuredOutput = parsed;
        }
      } catch {
        // Not JSON — fallback to parseStepOutcome in step-handler
      }
    }
  }

  const commitMessage = buildCommitMessage(options.taskID, options.prompt);
  const { diff, filesChanged, commitSha } = await finalizeGitWorktree(
    options.cwd,
    commitMessage,
  );

  return {
    exitCode,
    signalCode: child.signalCode,
    sessionID,
    events,
    diff,
    filesChanged,
    commitSha,
    logPath,
    durationMS: Date.now() - start,
    timedOut,
    aborted,
    error,
    structuredOutput,
  };
}

async function consumeStream(
  stream: ReadableStream<Uint8Array> | null,
  streamName: 'stdout' | 'stderr',
  onChunk: (text: string) => void,
  onLine: (stream: 'stdout' | 'stderr', line: string) => void,
): Promise<void> {
  if (!stream) return;

  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let pending = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.length === 0) continue;

    const text = decoder.decode(value, { stream: true });
    if (text) {
      onChunk(text);
      pending += text;
    }

    let lineBreak = pending.indexOf('\n');
    while (lineBreak >= 0) {
      const line = pending.slice(0, lineBreak);
      onLine(streamName, line);
      pending = pending.slice(lineBreak + 1);
      lineBreak = pending.indexOf('\n');
    }
  }

  const finalChunk = decoder.decode();
  if (finalChunk) {
    onChunk(finalChunk);
    pending += finalChunk;
  }

  if (pending.length > 0) {
    onLine(streamName, pending);
  }
}

function buildWorkerError(input: {
  aborted: boolean;
  timedOut: boolean;
  timeoutMS: number;
  writeError: string;
  exitCode: number;
}): string | undefined {
  if (input.timedOut) {
    return `process killed after timeout (${input.timeoutMS}ms)`;
  }
  if (input.aborted) {
    return 'process aborted';
  }
  if (input.writeError) {
    return `log write failed: ${input.writeError}`;
  }
  if (input.exitCode !== 0) {
    return `process exited with code ${input.exitCode}`;
  }
  return undefined;
}

function dirName(path: string): string {
  const idx = path.lastIndexOf('/');
  if (idx <= 0) return '.';
  return path.slice(0, idx);
}

function buildCommitMessage(taskID: string, prompt: string): string {
  const title = extractTaskTitle(prompt);
  return title || `orca: task ${taskID}`;
}

async function finalizeGitWorktree(
  worktreePath: string,
  commitMessage: string,
): Promise<{ diff: string; filesChanged: string[]; commitSha: string }> {
  await gitOutput(worktreePath, ['add', '-A']).catch(() => '');
  const committed = await gitOutput(worktreePath, [
    'commit',
    '-m',
    commitMessage,
  ])
    .then(() => true)
    .catch(() => false);
  if (!committed) {
    return { diff: '', filesChanged: [], commitSha: '' };
  }

  const [diff, filesChangedRaw, commitSha] = await Promise.all([
    gitOutput(worktreePath, ['diff', 'HEAD~1..HEAD']).catch(() => ''),
    gitOutput(worktreePath, ['diff', 'HEAD~1..HEAD', '--name-only']).catch(
      () => '',
    ),
    gitOutput(worktreePath, ['rev-parse', 'HEAD']).catch(() => ''),
  ]);

  return {
    diff,
    filesChanged: normalizeList(filesChangedRaw.split('\n')),
    commitSha: commitSha.trim(),
  };
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

function filteredEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === 'CLAUDECODE') continue;
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

function extractTaskTitle(prompt: string): string {
  const normalized = prompt.replaceAll('\r', '');
  const taskMatch = normalized.match(
    /(?:^|\n)## Task\s*\n+([\s\S]*?)(?:\n## |\n---\n|$)/,
  );
  if (!taskMatch) return '';

  const block = taskMatch[1] ?? '';
  for (const line of block.split('\n')) {
    const candidate = line.trim();
    if (!candidate) continue;
    if (candidate.startsWith('#')) continue;
    return candidate;
  }

  return '';
}
