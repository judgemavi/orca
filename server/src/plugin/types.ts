export interface HeadlessOpts {
  mcpConfig?: string;
  allowedTools?: string[] | string;
}

export interface MCPServerDef {
  command: string;
  args: string[];
  cwd: string;
}

export interface InteractiveOpts {
  model: string;
  systemPrompt: string;
  allowedTools: string[];
  mcpServers: Record<string, MCPServerDef>;
  repoDir: string;
}

export interface ToolPluginCost {
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
}

export interface ToolPluginEvent {
  type:
    | 'text'
    | 'tool_use'
    | 'tool_result'
    | 'cost'
    | 'session'
    | 'status'
    | 'error';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  cost?: ToolPluginCost;
  sessionID?: string;
  toolUseID?: string;
  isError?: boolean;
  raw?: string;
}

export interface ToolPlugin {
  name(): string;
  binary(): string;
  models(): string[];
  headlessArgs(
    prompt: string,
    model: string,
    dir: string,
    opts?: HeadlessOpts,
  ): string[];
  resumeArgs(
    sessionID: string,
    feedback: string,
    model: string,
    dir: string,
    opts?: HeadlessOpts,
  ): string[];
  interactiveArgs(opts: InteractiveOpts): Promise<string[]>;
  parseEvent(line: Buffer): ToolPluginEvent | null;
  parseSessionID(events: ToolPluginEvent[]): string | null;
}
