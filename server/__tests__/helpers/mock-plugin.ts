import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ClaudePlugin } from '../../src/plugin/claude';
import type { HeadlessOpts, ToolPlugin } from '../../src/plugin/types';

const MOCK_BINARY = resolve(__dirname, 'mock-claude.sh');

/**
 * ToolPlugin that delegates to mock-claude.sh.
 * Reuses ClaudePlugin's parseEvent/parseSessionID since the mock
 * outputs the same stream-json format.
 */
export class MockClaudePlugin implements ToolPlugin {
  private readonly delegate = new ClaudePlugin();

  /** Captured prompts: array of { mode, prompt } in call order. */
  readonly captures: Array<{ mode: string; prompt: string }> = [];

  name() {
    return 'claude';
  }
  binary() {
    return MOCK_BINARY;
  }
  models() {
    return ['mock-model'];
  }

  async headlessArgs(
    prompt: string,
    model: string,
    dir: string,
    opts?: HeadlessOpts,
  ): Promise<string[]> {
    const mode = detectMode(prompt);
    this.captures.push({ mode, prompt });

    // Also write to capture dir if set (for cross-process verification)
    const captureDir = process.env.ORCA_MOCK_CAPTURE_DIR;
    if (captureDir) {
      try {
        mkdirSync(captureDir, { recursive: true });
        const count = readdirSync(captureDir).filter((f) =>
          f.endsWith('.prompt'),
        ).length;
        writeFileSync(`${captureDir}/${count}-${mode}.prompt`, prompt);
      } catch {
        // best-effort capture
      }
    }

    return ['-p', prompt, '--model', model];
  }

  async resumeArgs(
    sessionID: string,
    feedback: string,
    model: string,
    dir: string,
    opts?: HeadlessOpts,
  ): Promise<string[]> {
    this.captures.push({ mode: 'resume', prompt: feedback });

    const captureDir = process.env.ORCA_MOCK_CAPTURE_DIR;
    if (captureDir) {
      try {
        mkdirSync(captureDir, { recursive: true });
        const count = readdirSync(captureDir).filter((f) =>
          f.endsWith('.prompt'),
        ).length;
        writeFileSync(`${captureDir}/${count}-resume.prompt`, feedback);
      } catch {
        // best-effort capture
      }
    }

    return ['--resume', sessionID, '-p', feedback, '--model', model];
  }

  async interactiveArgs() {
    return [];
  }

  parseEvent(line: Buffer) {
    return this.delegate.parseEvent(line);
  }

  parseSessionID(events: Parameters<ToolPlugin['parseSessionID']>[0]) {
    return this.delegate.parseSessionID(events);
  }
}

function detectMode(prompt: string): string {
  if (prompt.includes('task complexity evaluator')) return 'evaluate';
  if (prompt.includes('code reviewer')) return 'review';
  if (prompt.includes('implementation planner')) return 'plan';
  if (prompt.includes('retro generator')) return 'retro';
  if (/task breaker|decompose.*subtasks|break.*down.*goal/.test(prompt))
    return 'breakdown';
  return 'code';
}
