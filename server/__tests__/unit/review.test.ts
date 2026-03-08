import { describe, expect, test } from 'bun:test';
import {
  parseChecks,
  parseFindings,
  parseReviewPayload,
} from '../../src/domain/review';

function wrap(obj: Record<string, unknown>): string {
  return `Here is my review:\n${JSON.stringify(obj)}\nEnd of review.`;
}

describe('parseReviewPayload', () => {
  test('approved=true with feedback', () => {
    const result = parseReviewPayload(
      wrap({ approved: true, feedback: 'LGTM' }),
    );
    expect(result.approved).toBe(true);
    expect(result.feedback).toBe('LGTM');
  });

  test('approved=false with feedback', () => {
    const result = parseReviewPayload(
      wrap({ approved: false, feedback: 'Needs work' }),
    );
    expect(result.approved).toBe(false);
    expect(result.feedback).toBe('Needs work');
  });

  test('decision=approve (string) maps to approved=true', () => {
    const result = parseReviewPayload(
      wrap({ decision: 'approve', feedback: 'ok' }),
    );
    expect(result.approved).toBe(true);
  });

  test('decision=request-changes maps to approved=false', () => {
    const result = parseReviewPayload(
      wrap({ decision: 'request-changes', feedback: 'fix it' }),
    );
    expect(result.approved).toBe(false);
  });

  test('verdict=approved maps to approved=true', () => {
    const result = parseReviewPayload(
      wrap({ verdict: 'approved', feedback: 'good' }),
    );
    expect(result.approved).toBe(true);
  });

  test('verdict=rejected maps to approved=false', () => {
    const result = parseReviewPayload(
      wrap({ verdict: 'rejected', feedback: 'bad' }),
    );
    expect(result.approved).toBe(false);
  });

  test('status=request_changes maps to approved=false', () => {
    const result = parseReviewPayload(
      wrap({ status: 'request_changes', feedback: 'nope' }),
    );
    expect(result.approved).toBe(false);
  });

  test('status=changes_requested maps to approved=false', () => {
    const result = parseReviewPayload(
      wrap({ status: 'changes_requested', feedback: 'nope' }),
    );
    expect(result.approved).toBe(false);
  });

  test('missing approved/decision/verdict throws', () => {
    expect(() => parseReviewPayload(wrap({ feedback: 'hello' }))).toThrow(
      'missing approved/decision',
    );
  });

  test('missing feedback throws', () => {
    expect(() => parseReviewPayload(wrap({ approved: true }))).toThrow(
      'missing feedback',
    );
  });

  test('no JSON in output throws', () => {
    expect(() => parseReviewPayload('just plain text, no json here')).toThrow(
      'failed to parse review JSON',
    );
  });

  test('includes checks array parsed correctly', () => {
    const result = parseReviewPayload(
      wrap({
        approved: true,
        feedback: 'ok',
        checks: [{ key: 'lint', label: 'Lint check', passed: true }],
      }),
    );
    expect(result.checks).toEqual([
      { key: 'lint', label: 'Lint check', passed: true },
    ]);
  });

  test('includes findings array parsed correctly', () => {
    const result = parseReviewPayload(
      wrap({
        approved: false,
        feedback: 'issues',
        findings: [
          {
            id: 'f1',
            summary: 'Bug found',
            detail: 'Details here',
            passed: false,
          },
        ],
      }),
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].id).toBe('f1');
    expect(result.findings[0].summary).toBe('Bug found');
    expect(result.findings[0].passed).toBe(false);
  });

  test('findings with filePath and line number preserved', () => {
    const result = parseReviewPayload(
      wrap({
        approved: true,
        feedback: 'ok',
        findings: [
          {
            id: 'f1',
            summary: 'Issue',
            detail: 'det',
            passed: true,
            file_path: 'src/a.ts',
            line: 42,
          },
        ],
      }),
    );
    expect(result.findings[0].filePath).toBe('src/a.ts');
    expect(result.findings[0].line).toBe(42);
  });

  test('findings without id generates finding-N id', () => {
    const result = parseReviewPayload(
      wrap({
        approved: true,
        feedback: 'ok',
        findings: [{ summary: 'No id here', detail: 'x', passed: true }],
      }),
    );
    expect(result.findings[0].id).toBe('finding-0');
  });
});

describe('parseChecks', () => {
  test('valid checks returns array', () => {
    const result = parseChecks([
      { key: 'lint', label: 'Lint', passed: true },
      { key: 'test', label: 'Tests', passed: false },
    ]);
    expect(result).toEqual([
      { key: 'lint', label: 'Lint', passed: true },
      { key: 'test', label: 'Tests', passed: false },
    ]);
  });

  test('missing key filtered out', () => {
    const result = parseChecks([
      { label: 'No key', passed: true },
      { key: 'valid', label: 'Valid', passed: true },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('valid');
  });

  test('non-object items filtered out', () => {
    const result = parseChecks([
      null,
      'string',
      42,
      [],
      { key: 'ok', passed: true },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('ok');
  });
});

describe('parseFindings', () => {
  test('valid findings returns array', () => {
    const result = parseFindings([
      { id: 'f1', summary: 'Bug', detail: 'Details', passed: false },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].summary).toBe('Bug');
  });

  test('missing summary filtered out', () => {
    const result = parseFindings([
      { id: 'f1', detail: 'no summary' },
      { id: 'f2', summary: 'Has summary', detail: 'ok' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('f2');
  });

  test('non-object items filtered out', () => {
    const result = parseFindings([null, 'str', 123, [], { summary: 'ok' }]);
    expect(result).toHaveLength(1);
  });

  test('passed defaults to true when not provided', () => {
    const result = parseFindings([{ id: 'f1', summary: 'Thing', detail: 'x' }]);
    expect(result[0].passed).toBe(true);
  });
});
