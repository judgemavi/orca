import type {
  HeadlessOpts,
  InteractiveOpts,
  MCPServerDef,
  ToolPlugin,
  ToolPluginEvent,
} from './types';

function mcpFlagsFromDef(name: string, server: MCPServerDef): string[] {
  return [
    '-c',
    `mcp_servers.${name}.command=${JSON.stringify(server.command)}`,
    '-c',
    `mcp_servers.${name}.args=${JSON.stringify(server.args)}`,
    '-c',
    `mcp_servers.${name}.cwd=${JSON.stringify(server.cwd)}`,
    '-c',
    `mcp_servers.${name}.enabled=true`,
  ];
}

function mcpFlagsFromDefs(servers: Record<string, MCPServerDef>): string[] {
  const flags: string[] = [];
  for (const [name, server] of Object.entries(servers)) {
    flags.push(...mcpFlagsFromDef(name, server));
  }
  return flags;
}

export class CodexPlugin implements ToolPlugin {
  name(): string {
    return 'codex';
  }

  binary(): string {
    return 'codex';
  }

  models(): string[] {
    return [
      'gpt-5.3-codex',
      'gpt-5.2-codex',
      'gpt-5.1-codex-max',
      'gpt-5.1-codex',
      'gpt-5-codex',
      'gpt-5-codex-mini',
    ];
  }

  async headlessArgs(
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
    if (opts?.mcpServer) {
      args.push(...mcpFlagsFromDef('orca', opts.mcpServer));
    }
    return args;
  }

  async resumeArgs(
    sessionID: string,
    feedback: string,
    model: string,
    dir: string,
    opts?: HeadlessOpts,
  ): Promise<string[]> {
    const args = [
      'exec',
      'resume',
      sessionID,
      feedback,
      '--json',
      '--full-auto',
    ];
    const resolvedDir = dir.trim();
    const resolvedModel = model.trim();
    if (resolvedDir) {
      args.unshift(resolvedDir);
      args.unshift('-C');
    }
    if (resolvedModel) {
      args.push('--model', resolvedModel);
    }
    if (opts?.mcpServer) {
      args.push(...mcpFlagsFromDef('orca', opts.mcpServer));
    }
    return args;
  }

  async interactiveArgs(opts: InteractiveOpts): Promise<string[]> {
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
    args.push(...mcpFlagsFromDefs(opts.mcpServers));
    return args;
  }

  parseEvent(line: Buffer): ToolPluginEvent | null {
    const raw = line.toString('utf8').replace(/\r/g, '').trim();
    if (!raw) return null;

    const parsed = parseJSON(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { type: 'text', text: raw, raw };
    }

    const type = asString((parsed as any).type);
    if (type === 'thread.started') {
      const sessionID = asString((parsed as any).thread_id);
      if (!sessionID) return null;
      return { type: 'session', sessionID, raw };
    }

    if (type === 'item.started') {
      const itemType = asString((parsed as any).item?.type);
      if (itemType !== 'mcp_tool_call') return null;
      return {
        type: 'tool_use',
        toolName: asString((parsed as any).item?.name) || 'tool',
        toolInput: (parsed as any).item?.input ?? {},
        toolUseID: asString((parsed as any).item?.id),
        raw,
      };
    }

    if (type === 'item.completed') {
      const itemType = asString((parsed as any).item?.type);
      if (itemType === 'agent_message') {
        const text = pickMessageText((parsed as any).item);
        if (!text) return null;
        // Ensure each message is newline-terminated so collectAssistantText
        // produces properly separated output (unlike Claude's streaming chunks,
        // each Codex agent_message is a complete discrete message)
        const separated = text.endsWith('\n') ? text : `${text}\n`;
        return { type: 'text', text: separated, raw };
      }
      if (itemType === 'mcp_tool_call') {
        return {
          type: 'tool_result',
          toolName: asString((parsed as any).item?.name),
          toolResult:
            (parsed as any).item?.output ?? (parsed as any).item?.result ?? {},
          toolUseID: asString((parsed as any).item?.id),
          isError: Boolean((parsed as any).item?.is_error),
          raw,
        };
      }
      return null;
    }

    if (type === 'turn.completed') {
      const usage = (parsed as any).usage ?? (parsed as any).turn?.usage ?? {};
      return {
        type: 'cost',
        cost: {
          inputTokens: asNumber(usage.input_tokens),
          outputTokens: asNumber(usage.output_tokens),
          totalCost: asNumber((parsed as any).total_cost_usd),
        },
        raw,
      };
    }

    return null;
  }

  parseSessionID(events: ToolPluginEvent[]): string | null {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event?.type !== 'session') continue;
      const session = event.sessionID?.trim();
      if (session) return session;
    }
    return null;
  }
}

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

function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
