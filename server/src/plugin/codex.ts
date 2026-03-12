import type {
  HeadlessOpts,
  InteractiveOpts,
  ToolPlugin,
  ToolPluginEvent,
} from './types';

async function codexHeadlessArgs(
  prompt: string,
  model: string,
  dir: string,
  opts?: HeadlessOpts,
): Promise<string[]> {
  const args = ['exec', prompt, '--json', '--full-auto'];
  const resolvedDir = dir.trim();
  const resolvedModel = model.trim();
  if (resolvedDir) {
    args.unshift(resolvedDir);
    args.unshift('-C');
  }
  if (resolvedModel) {
    args.push('--model', resolvedModel);
  }
  if (opts?.schemaPath) {
    args.push('--output-schema', opts.schemaPath);
  } else if (opts?.jsonSchema) {
    const path = await writeSchemaFile(dir, opts.jsonSchema);
    args.push('--output-schema', path);
  }
  return args;
}

async function codexResumeArgs(
  sessionID: string,
  feedback: string,
  model: string,
  dir: string,
  _opts?: HeadlessOpts,
): Promise<string[]> {
  const args = ['exec', 'resume', sessionID, feedback, '--json', '--full-auto'];
  const resolvedDir = dir.trim();
  const resolvedModel = model.trim();
  if (resolvedDir) {
    args.unshift(resolvedDir);
    args.unshift('-C');
  }
  if (resolvedModel) {
    args.push('--model', resolvedModel);
  }
  return args;
}

async function codexInteractiveArgs(opts: InteractiveOpts): Promise<string[]> {
  const args = ['--full-auto'];
  if (opts.model.trim()) {
    args.push('--model', opts.model.trim());
  }
  if (opts.systemPrompt.trim()) {
    args.push(
      '-c',
      `developer_instructions=${JSON.stringify(opts.systemPrompt.trim())}`,
    );
  }
  return args;
}

function codexParseEvent(line: Buffer): ToolPluginEvent | null {
  const raw = line.toString('utf8').replaceAll('\r', '').trim();
  if (!raw) return null;

  const parsed = parseJSON(raw) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== 'object') {
    return { type: 'text', text: raw, raw };
  }

  const item = parsed.item as Record<string, unknown> | undefined;
  const type = asString(parsed.type);
  if (type === 'thread.started') {
    const sessionID = asString(parsed.thread_id);
    if (!sessionID) return null;
    return { type: 'session', sessionID, raw };
  }

  if (type === 'item.started') {
    const itemType = asString(item?.type);
    if (itemType !== 'mcp_tool_call') return null;
    return {
      type: 'tool_use',
      toolName: asString(item?.name) || 'tool',
      toolInput: (item?.input as Record<string, unknown>) ?? {},
      toolUseID: asString(item?.id),
      raw,
    };
  }

  if (type === 'item.completed') {
    const itemType = asString(item?.type);
    if (itemType === 'agent_message') {
      const text = pickMessageText(item);
      if (!text) return null;
      const separated = text.endsWith('\n') ? text : `${text}\n`;
      return { type: 'text', text: separated, raw };
    }
    if (itemType === 'mcp_tool_call') {
      return {
        type: 'tool_result',
        toolName: asString(item?.name),
        toolResult:
          (item?.output as Record<string, unknown>) ??
          (item?.result as Record<string, unknown>) ??
          {},
        toolUseID: asString(item?.id),
        isError: Boolean(item?.is_error),
        raw,
      };
    }
    return null;
  }

  return null;
}

function codexParseSessionID(events: ToolPluginEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type !== 'session') continue;
    const session = event.sessionID?.trim();
    if (session) return session;
  }
  return null;
}

export const codexPlugin: ToolPlugin = {
  name: () => 'codex',
  binary: () => 'codex',
  models: () => [
    'gpt-5.4',
    'gpt-5.3-codex',
    'gpt-5.2-codex',
    'gpt-5.1-codex-max',
    'gpt-5.1-codex',
    'gpt-5-codex',
    'gpt-5-codex-mini',
  ],
  headlessArgs: codexHeadlessArgs,
  resumeArgs: codexResumeArgs,
  interactiveArgs: codexInteractiveArgs,
  parseEvent: codexParseEvent,
  parseSessionID: codexParseSessionID,
};

function pickMessageText(item: any): string {
  if (typeof item?.text === 'string' && item.text.trim())
    return item.text.trim();
  const content = item?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const textParts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (typeof part.text === 'string' && part.text.trim()) {
      textParts.push(part.text.trim());
      continue;
    }
    if (typeof part.content === 'string' && part.content.trim()) {
      textParts.push(part.content.trim());
    }
  }
  return textParts.join('\n').trim();
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

async function writeSchemaFile(
  dir: string,
  schema: Record<string, unknown>,
): Promise<string> {
  const orcaDir = `${dir.replace(/\/+$/, '')}/.orca`;
  await Bun.$`mkdir -p ${orcaDir}`;
  const schemaPath = `${orcaDir}/step-schema.json`;
  await Bun.write(schemaPath, JSON.stringify(schema, null, 2) + '\n');
  return schemaPath;
}
