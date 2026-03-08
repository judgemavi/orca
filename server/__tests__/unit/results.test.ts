import { describe, expect, test } from 'bun:test';
import { evaluateTaskOutcome } from '../../src/executor/results';

function base() {
  return {
    exitCode: 0,
    timedOut: false,
    aborted: false,
    diff: '',
    outputTail: '',
  };
}

describe('evaluateTaskOutcome', () => {
  test('aborted returns stopped + failed', () => {
    const result = evaluateTaskOutcome({ ...base(), aborted: true });
    expect(result.taskStatus).toBe('stopped');
    expect(result.interactionStatus).toBe('failed');
  });

  test('timedOut returns failed with timed out error', () => {
    const result = evaluateTaskOutcome({ ...base(), timedOut: true });
    expect(result.taskStatus).toBe('failed');
    expect(result.interactionStatus).toBe('failed');
    expect(result.error).toContain('timed out');
  });

  test('non-zero exitCode returns failed', () => {
    const result = evaluateTaskOutcome({ ...base(), exitCode: 1 });
    expect(result.taskStatus).toBe('failed');
    expect(result.interactionStatus).toBe('failed');
    expect(result.error).toContain('exited with code 1');
  });

  test('exitCode 0 with diff returns review + completed', () => {
    const result = evaluateTaskOutcome({
      ...base(),
      diff: 'diff --git a/foo b/foo\n+bar',
    });
    expect(result.taskStatus).toBe('review');
    expect(result.interactionStatus).toBe('completed');
    expect(result.error).toBeUndefined();
  });

  test('exitCode 0 + no diff + blocker pattern returns failed with blocker', () => {
    const result = evaluateTaskOutcome({
      ...base(),
      outputTail: 'Error: BLOCKED: cannot access resource',
    });
    expect(result.taskStatus).toBe('failed');
    expect(result.interactionStatus).toBe('failed');
    expect(result.error).toContain('blocker');
  });

  test('exitCode 0 + no diff + no blocker returns failed with no changes', () => {
    const result = evaluateTaskOutcome({
      ...base(),
      outputTail: 'all done, nothing to do',
    });
    expect(result.taskStatus).toBe('failed');
    expect(result.interactionStatus).toBe('failed');
    expect(result.error).toBe('no changes produced');
  });

  test('workerError overrides default error messages', () => {
    const aborted = evaluateTaskOutcome({
      ...base(),
      aborted: true,
      workerError: 'custom abort reason',
    });
    expect(aborted.error).toBe('custom abort reason');

    const timedOut = evaluateTaskOutcome({
      ...base(),
      timedOut: true,
      workerError: 'custom timeout reason',
    });
    expect(timedOut.error).toBe('custom timeout reason');

    const nonZero = evaluateTaskOutcome({
      ...base(),
      exitCode: 2,
      workerError: 'custom exit reason',
    });
    expect(nonZero.error).toBe('custom exit reason');
  });

  describe('blocker pattern detection', () => {
    const blockerPatterns = [
      'BLOCKED: something',
      'permission denied',
      'read-only file system',
      'sandbox blocked the operation',
      'sandbox prevented write',
      'sandbox restricted access',
      'cannot complete the request',
      'operation not permitted',
      'unable to write to disk',
    ];

    for (const pattern of blockerPatterns) {
      test(`detects "${pattern}"`, () => {
        const result = evaluateTaskOutcome({
          ...base(),
          outputTail: `some output before ${pattern} and after`,
        });
        expect(result.taskStatus).toBe('failed');
        expect(result.error).toContain('blocker');
      });
    }

    test('does not false-positive on normal output', () => {
      const result = evaluateTaskOutcome({
        ...base(),
        outputTail: 'successfully compiled 42 files',
      });
      expect(result.error).toBe('no changes produced');
      expect(result.error).not.toContain('blocker');
    });
  });

  test('aborted takes priority over timedOut', () => {
    const result = evaluateTaskOutcome({
      ...base(),
      aborted: true,
      timedOut: true,
    });
    expect(result.taskStatus).toBe('stopped');
  });

  test('whitespace-only diff treated as no diff', () => {
    const result = evaluateTaskOutcome({
      ...base(),
      diff: '   \n  \t  ',
    });
    expect(result.taskStatus).toBe('failed');
    expect(result.error).toBe('no changes produced');
  });
});
