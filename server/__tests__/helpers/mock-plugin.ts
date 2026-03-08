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
    return ['-p', prompt, '--model', model];
  }

  async resumeArgs(
    sessionID: string,
    feedback: string,
    model: string,
    dir: string,
    opts?: HeadlessOpts,
  ): Promise<string[]> {
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
