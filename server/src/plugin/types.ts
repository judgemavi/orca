export interface HeadlessOpts {
  allowedTools?: string[] | string;
  jsonSchema?: Record<string, unknown>;
  schemaPath?: string;
}

export interface InteractiveOpts {
  model: string;
  systemPrompt: string;
  allowedTools: string[];
  repoDir: string;
}

export interface ToolPluginEvent {
  type: 'text' | 'tool_use' | 'tool_result' | 'session' | 'status' | 'error';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
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
  ): Promise<string[]>;
  resumeArgs(
    sessionID: string,
    feedback: string,
    model: string,
    dir: string,
    opts?: HeadlessOpts,
  ): Promise<string[]>;
  interactiveArgs(opts: InteractiveOpts): Promise<string[]>;
  parseEvent(line: Buffer): ToolPluginEvent | null;
  parseSessionID(events: ToolPluginEvent[]): string | null;
}
