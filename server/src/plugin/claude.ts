import type {
  HeadlessOpts,
  InteractiveOpts,
  ToolPlugin,
  ToolPluginEvent,
} from './types';

export class ClaudePlugin implements ToolPlugin {
  private readonly partialToolInput = new Map<string, string>();
  private readonly partialToolName = new Map<string, string>();

  name(): string {
    return 'claude';
  }

  binary(): string {
    return 'claude';
  }

  models(): string[] {
    return [
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001',
      'claude-opus-4-5-20251101',
      'claude-sonnet-4-5-20250929',
    ];
  }

  async headlessArgs(
    prompt: string,
    model: string,
    _dir: string,
    opts?: HeadlessOpts,
  ): Promise<string[]> {
    const useJsonSchema = opts?.jsonSchema != null;
    const args = [
      '-p',
      prompt,
      '--output-format',
      useJsonSchema ? 'json' : 'stream-json',
      ...(useJsonSchema ? [] : ['--verbose']),
      '--permission-mode',
      'bypassPermissions',
    ];
    if (useJsonSchema) {
      args.push('--json-schema', JSON.stringify(opts!.jsonSchema));
    }
    const resolvedModel = model.trim();
    if (resolvedModel) {
      args.push('--model', resolvedModel);
    }
    const allowed = normalizeAllowed(opts?.allowedTools);
    if (allowed.length > 0) {
      args.push('--allowedTools', allowed.join(','));
    }
    return args;
  }

  async resumeArgs(
    sessionID: string,
    feedback: string,
    model: string,
    _dir: string,
    opts?: HeadlessOpts,
  ): Promise<string[]> {
    const args = [
      '--resume',
      sessionID,
      '-p',
      feedback,
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
    ];
    const resolvedModel = model.trim();
    if (resolvedModel) {
      args.push('--model', resolvedModel);
    }
    const allowed = normalizeAllowed(opts?.allowedTools);
    if (allowed.length > 0) {
      args.push('--allowedTools', allowed.join(','));
    }
    return args;
  }

  async interactiveArgs(opts: InteractiveOpts): Promise<string[]> {
    const args = ['--permission-mode', 'acceptEdits', '--model', opts.model];

    if (opts.allowedTools.length > 0) {
      args.push('--allowedTools', opts.allowedTools.join(','));
    }
    if (opts.systemPrompt.trim()) {
      args.push('--append-system-prompt', opts.systemPrompt.trim());
    }
    return args;
  }

  parseEvent(line: Buffer): ToolPluginEvent | null {
    const raw = line.toString('utf8').replaceAll('\r', '').trim();
    if (!raw) return null;

    const parsed = parseJSON(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { type: 'text', text: raw, raw };
    }

    const event = unwrapStreamEnvelope(parsed) as Record<
      string,
      unknown
    > | null;
    if (!event || typeof event !== 'object') {
      return { type: 'text', text: raw, raw };
    }

    const type = asString(event.type);
    if (type === 'content_block_delta') {
      const delta = event.delta as Record<string, unknown> | undefined;
      const deltaType = asString(delta?.type);
      if (deltaType === 'text_delta') {
        const text = asString(delta?.text);
        if (!text) return null;
        return { type: 'text', text, raw };
      }
      if (deltaType === 'input_json_delta') {
        const key = toolKey(event);
        if (!key) return null;
        const chunk = asString(delta?.partial_json);
        if (!chunk) return null;
        this.partialToolInput.set(
          key,
          (this.partialToolInput.get(key) ?? '') + chunk,
        );
        return null;
      }
      return null;
    }

    if (type === 'content_block_start') {
      const block = event.content_block as Record<string, unknown> | undefined;
      const blockType = asString(block?.type);
      const key = toolKey(event);
      if (blockType === 'tool_use') {
        const name = asString(block?.name) || 'tool';
        if (key) {
          this.partialToolName.set(key, name);
        }
        if (block?.input && typeof block.input === 'object') {
          return {
            type: 'tool_use',
            toolName: name,
            toolInput: block.input,
            toolUseID: key,
            raw,
          };
        }
        return null;
      }
      if (blockType === 'tool_result') {
        return {
          type: 'tool_result',
          toolName: asString(block?.name) || '',
          toolResult: block?.content ?? block ?? {},
          toolUseID: asString(block?.tool_use_id) || key || '',
          isError: Boolean(block?.is_error),
          raw,
        };
      }
      return null;
    }

    if (type === 'content_block_stop') {
      const key = toolKey(event);
      if (!key) return null;
      const name = this.partialToolName.get(key) ?? '';
      const partial = this.partialToolInput.get(key) ?? '';
      this.partialToolInput.delete(key);
      this.partialToolName.delete(key);
      if (!name || !partial) return null;
      return {
        type: 'tool_use',
        toolName: name,
        toolInput: parseJSON(partial) ?? partial,
        toolUseID: key,
        raw,
      };
    }

    if (type === 'assistant') {
      const msg = event.message as Record<string, unknown> | undefined;
      const content = msg?.content;
      if (Array.isArray(content)) {
        const texts: string[] = [];
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string') {
            texts.push(block.text);
          }
        }
        if (texts.length > 0) {
          return { type: 'text', text: texts.join(''), raw };
        }
      }
      const resultText = asString(msg?.content);
      if (resultText) {
        return { type: 'text', text: resultText, raw };
      }
      return null;
    }

    if (type === 'result') {
      const sessionID = asString(event.session_id);
      if (!sessionID) return null;
      return { type: 'session', sessionID, raw };
    }

    return null;
  }

  parseSessionID(events: ToolPluginEvent[]): string | null {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const session = events[i]?.sessionID?.trim();
      if (session) return session;
    }
    return null;
  }
}

function normalizeAllowed(input: string[] | string | undefined): string[] {
  if (!input) return [];
  if (Array.isArray(input)) {
    return dedupe(input.map((item) => item.trim()).filter(Boolean));
  }
  return dedupe(
    input
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function toolKey(parsed: unknown): string {
  const obj = parsed as Record<string, unknown>;
  const block = obj.content_block as Record<string, unknown> | undefined;
  return asString(block?.id) || String(obj.index ?? '');
}

function unwrapStreamEnvelope(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const obj = parsed as Record<string, unknown>;
  if (asString(obj.type) !== 'stream_event') {
    return parsed;
  }
  const event = obj.event;
  if (!event || typeof event !== 'object') {
    return parsed;
  }
  return event;
}

function parseJSON(raw: string): any | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
