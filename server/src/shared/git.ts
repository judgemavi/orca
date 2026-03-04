import { streamToText } from './stream';

export interface GitRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export const REF_LOCK_RETRY_BACKOFF_MS = [100, 200, 400];

export async function gitRun(
  cwd: string,
  args: string[],
): Promise<GitRunResult> {
  const child = Bun.spawn({
    cmd: ['git', '-C', cwd, ...args],
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    streamToText(child.stdout),
    streamToText(child.stderr),
    child.exited,
  ]);

  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    exitCode,
  };
}

export function isRefLockError(stderr: string, code: number): boolean {
  return (
    code === 128 &&
    stderr.includes('Unable to create') &&
    stderr.includes('.lock')
  );
}

export function isRefLockErrorResult(result: {
  code: number;
  stderr: string;
}): boolean {
  return isRefLockError(result.stderr, result.code);
}

export function formatRefLockContentionError(stderr: string): string {
  return `git ref lock contention after retries: ${stderr || 'Unable to create lock file'}`;
}

export async function gitRunWithRefLockRetry(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  let result = await gitRun(cwd, args);
  let retryResult = {
    code: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };

  for (const delayMS of REF_LOCK_RETRY_BACKOFF_MS) {
    if (!isRefLockErrorResult(retryResult)) {
      return retryResult;
    }
    await Bun.sleep(delayMS);
    result = await gitRun(cwd, args);
    retryResult = {
      code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  return retryResult;
}

export async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const result = await gitRun(cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr ||
        result.stdout ||
        `git ${args.join(' ')} failed with exit code ${result.exitCode}`,
    );
  }
  return result.stdout;
}
