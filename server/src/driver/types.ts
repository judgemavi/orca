export interface HeadlessOpts {
  mcpConfig?: string
  allowedTools?: string[] | string
}

export interface DriverCost {
  inputTokens: number
  outputTokens: number
  totalCost: number
}

export interface DriverEvent {
  type: 'text' | 'tool_use' | 'tool_result' | 'cost' | 'session' | 'status' | 'error'
  text?: string
  toolName?: string
  toolInput?: unknown
  toolResult?: unknown
  cost?: DriverCost
  sessionID?: string
  toolUseID?: string
  isError?: boolean
  raw?: string
}

export interface Driver {
  name(): string
  binary(): string
  models(): string[]
  headlessArgs(prompt: string, model: string, dir: string, opts?: HeadlessOpts): string[]
  resumeArgs(
    sessionID: string,
    feedback: string,
    model: string,
    dir: string,
    opts?: HeadlessOpts,
  ): string[]
  parseEvent(line: Buffer): DriverEvent | null
  parseSessionID(events: DriverEvent[]): string | null
}

