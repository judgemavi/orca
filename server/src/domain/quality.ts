import { streamToText } from '../shared/stream';
import { classifyDiffFromGit } from './diff-classify';

export interface ScopeAnalysis {
  taskId: string;
  filesChanged: number;
  linesChanged: number;
  flags: string[];
  excessive: boolean;
}

export interface ValidationCommandResult {
  command: string;
  exitCode: number;
  output: string;
}

export interface ValidationSnapshot {
  results: ValidationCommandResult[];
  takenAt: string;
}

export interface TestDelta {
  newFailures: string[];
  newPasses: string[];
  unchanged: string[];
  testCountDelta: number;
}

export interface QualityResult {
  scope?: ScopeAnalysis;
  testDelta?: TestDelta;
  blockingIssues: string[];
}

function analyzeScope(
  taskID: string,
  title: string,
  diff: string,
  nameStatus = '',
  numStat = '',
): ScopeAnalysis {
  const files = new Set<string>();
  let added = 0;
  let removed = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git a/')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 3) {
        const path = parts[2]?.replace(/^a\//, '').trim() ?? '';
        if (path) files.add(path);
      }
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }

  const classified = classifyDiffFromGit(nameStatus, numStat);
  for (const change of classified.files) {
    if (change.oldPath) files.add(change.oldPath);
    if (change.newPath) files.add(change.newPath);
  }

  const topDirs = new Set(
    [...files].map((path) =>
      path.includes('/') ? path.slice(0, path.indexOf('/')) : '(root)',
    ),
  );
  const testFiles = [...files].filter((path) => isTestFile(path)).length;
  const fileCount = files.size;
  const linesChanged =
    classified.totalChurn > 0 ? classified.totalChurn : added + removed;
  const threshold = fileThreshold(title);
  const flags: string[] = [];
  const refactorTask = /\b(refactor|rename)\b/i.test(title);

  if (fileCount > threshold) {
    flags.push(
      `${fileCount} files changed (expected <${threshold} for task size)`,
    );
  }
  if (!refactorTask && linesChanged > 500) {
    flags.push('high line churn for non-refactor task (>500 changed lines)');
  }
  if (testFiles === 0 && fileCount > 3) {
    flags.push('no tests added for multi-file change');
  }
  if (topDirs.size > 3) {
    flags.push('changes span many directories');
  }

  return {
    taskId: taskID,
    filesChanged: fileCount,
    linesChanged: linesChanged,
    flags,
    excessive: flags.length > 0,
  };
}

export async function takeValidationSnapshot(
  cwd: string,
  commands: string[],
): Promise<ValidationSnapshot> {
  const results: ValidationCommandResult[] = [];
  for (const command of commands.map((value) => value.trim()).filter(Boolean)) {
    const child = Bun.spawn({
      cmd: ['sh', '-lc', command],
      cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      streamToText(child.stdout),
      streamToText(child.stderr),
      child.exited,
    ]);
    results.push({
      command,
      exitCode: code,
      output: `${stdout}\n${stderr}`.trim(),
    });
  }

  return {
    results,
    takenAt: new Date().toISOString(),
  };
}

function computeTestDelta(
  before: ValidationSnapshot | null,
  after: ValidationSnapshot | null,
): TestDelta {
  const delta: TestDelta = {
    newFailures: [],
    newPasses: [],
    unchanged: [],
    testCountDelta: -1,
  };
  if (!before || !after) return delta;

  const beforeByCommand = new Map(
    before.results.map((result) => [result.command, result]),
  );
  let beforeTests = 0;
  let afterTests = 0;
  let hasCounts = true;

  for (const result of after.results) {
    const baseline = beforeByCommand.get(result.command);
    if (!baseline) continue;

    if (baseline.exitCode === 0 && result.exitCode !== 0) {
      delta.newFailures.push(result.command);
    } else if (baseline.exitCode !== 0 && result.exitCode === 0) {
      delta.newPasses.push(result.command);
    } else {
      delta.unchanged.push(result.command);
    }

    const beforeCount = parseTestCount(baseline.output);
    const afterCount = parseTestCount(result.output);
    if (beforeCount < 0 || afterCount < 0) {
      hasCounts = false;
      continue;
    }
    beforeTests += beforeCount;
    afterTests += afterCount;
  }

  if (hasCounts) {
    delta.testCountDelta = afterTests - beforeTests;
  }
  return delta;
}

export function evaluateQualityGates(input: {
  enabled: boolean;
  scopeCheck: boolean;
  testDelta: boolean;
  taskId: string;
  taskTitle: string;
  diff: string;
  nameStatus?: string;
  numStat?: string;
  before: ValidationSnapshot | null;
  after: ValidationSnapshot | null;
}): QualityResult {
  const result: QualityResult = {
    blockingIssues: [],
  };
  if (!input.enabled) return result;

  if (input.scopeCheck) {
    const scope = analyzeScope(
      input.taskId,
      input.taskTitle,
      input.diff,
      input.nameStatus ?? '',
      input.numStat ?? '',
    );
    result.scope = scope;
    if (scope.excessive) {
      result.blockingIssues.push(...scope.flags);
    }
  }

  if (input.testDelta) {
    const delta = computeTestDelta(input.before, input.after);
    result.testDelta = delta;
    if (delta.newFailures.length > 0) {
      result.blockingIssues.push(
        `new validation failures: ${delta.newFailures.join(', ')}`,
      );
    }
  }

  return result;
}

function fileThreshold(title: string): number {
  if (/\b(refactor|rename)\b/i.test(title)) return 20;
  if (/\b(fix|patch|typo)\b/i.test(title)) return 5;
  if (/\b(add|create|implement)\b/i.test(title)) return 10;
  return 8;
}

function isTestFile(path: string): boolean {
  return (
    path.endsWith('_test.go') ||
    path.endsWith('.test.ts') ||
    path.includes('.spec.') ||
    path.includes('/test/') ||
    path.includes('/tests/')
  );
}

function parseTestCount(output: string): number {
  const goPass = output.match(/^--- PASS:/gm);
  if (goPass?.length) return goPass.length;

  const goOK = output.match(/^ok\s+\S+\s+[\d.]+s(?:\s|$)/gm);
  if (goOK?.length) return goOK.length;

  const generic = output.match(/\b(\d+)\s+tests?\b/i);
  if (generic?.[1]) return Number.parseInt(generic[1], 10) || -1;

  return -1;
}
