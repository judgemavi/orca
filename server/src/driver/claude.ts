import type { Driver, DriverEvent, HeadlessOpts } from './types'

export class ClaudeDriver implements Driver {
  private readonly partialToolInput = new Map<string, string>()
  private readonly partialToolName = new Map<string, string>()

  name(): string {
    return 'claude'
  }

  binary(): string {
    return 'claude'
  }

  models(): string[] {
    return [
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001',
      'claude-opus-4-5-20251101',
      'claude-sonnet-4-5-20250929',
    ]
  }

  headlessArgs(prompt: string, model: string, _dir: string, opts?: HeadlessOpts): string[] {
    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
    ]
    const resolvedModel = model.trim()
    if (resolvedModel) {
      args.push('--model', resolvedModel)
    }
    if (opts?.mcpConfig?.trim()) {
      args.push('--mcp-config', opts.mcpConfig.trim())
    }
    const allowed = normalizeAllowed(opts?.allowedTools)
    if (allowed.length > 0) {
      args.push('--allowedTools', allowed.join(','))
    }
    return args
  }

  resumeArgs(
    sessionID: string,
    feedback: string,
    model: string,
    _dir: string,
    opts?: HeadlessOpts,
  ): string[] {
    const args = [
      '--resume', sessionID,
      '-p', feedback,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
    ]
    const resolvedModel = model.trim()
    if (resolvedModel) {
      args.push('--model', resolvedModel)
    }
    if (opts?.mcpConfig?.trim()) {
      args.push('--mcp-config', opts.mcpConfig.trim())
    }
    const allowed = normalizeAllowed(opts?.allowedTools)
    if (allowed.length > 0) {
      args.push('--allowedTools', allowed.join(','))
    }
    return args
  }

  interactiveArgs(
    mcpConfig: string,
    allowedTools: string[],
    context: string,
    model: string,
  ): string[] {
    const args = [
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
      '--model', model,
    ]
    if (mcpConfig.trim()) {
      args.push('--mcp-config', mcpConfig.trim())
    }
    if (allowedTools.length > 0) {
      args.push('--allowedTools', allowedTools.join(','))
    }
    if (context.trim()) {
      args.push('--append-system-prompt', context.trim())
    }
    return args
  }

  parseEvent(line: Buffer): DriverEvent | null {
    const raw = line.toString('utf8').replace(/\r/g, '').trim()
    if (!raw) return null

    const parsed = parseJSON(raw)
    if (!parsed || typeof parsed !== 'object') {
      return { type: 'text', text: raw, raw }
    }

    const event = unwrapStreamEnvelope(parsed)
    if (!event || typeof event !== 'object') {
      return { type: 'text', text: raw, raw }
    }

    const type = asString((event as any).type)
    if (type === 'content_block_delta') {
      const delta = (event as any).delta
      const deltaType = asString(delta?.type)
      if (deltaType === 'text_delta') {
        const text = asString(delta?.text)
        if (!text) return null
        return { type: 'text', text, raw }
      }
      if (deltaType === 'input_json_delta') {
        const key = toolKey(event)
        if (!key) return null
        const chunk = asString(delta?.partial_json)
        if (!chunk) return null
        this.partialToolInput.set(key, (this.partialToolInput.get(key) ?? '') + chunk)
        return null
      }
      return null
    }

    if (type === 'content_block_start') {
      const block = (event as any).content_block
      const blockType = asString(block?.type)
      const key = toolKey(event)
      if (blockType === 'tool_use') {
        const name = asString(block?.name) || 'tool'
        if (key) {
          this.partialToolName.set(key, name)
        }
        if (block?.input && typeof block.input === 'object') {
          return {
            type: 'tool_use',
            toolName: name,
            toolInput: block.input,
            toolUseID: key,
            raw,
          }
        }
        return null
      }
      if (blockType === 'tool_result') {
        return {
          type: 'tool_result',
          toolName: asString(block?.name) || '',
          toolResult: block?.content ?? block ?? {},
          toolUseID: asString(block?.tool_use_id) || key || '',
          isError: Boolean(block?.is_error),
          raw,
        }
      }
      return null
    }

    if (type === 'content_block_stop') {
      const key = toolKey(event)
      if (!key) return null
      const name = this.partialToolName.get(key) ?? ''
      const partial = this.partialToolInput.get(key) ?? ''
      this.partialToolInput.delete(key)
      this.partialToolName.delete(key)
      if (!name || !partial) return null
      return {
        type: 'tool_use',
        toolName: name,
        toolInput: parseJSON(partial) ?? partial,
        toolUseID: key,
        raw,
      }
    }

    if (type === 'assistant') {
      const content = (event as any).message?.content
      if (Array.isArray(content)) {
        const texts: string[] = []
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string') {
            texts.push(block.text)
          }
        }
        if (texts.length > 0) {
          return { type: 'text', text: texts.join(''), raw }
        }
      }
      const resultText = asString((event as any).message?.content)
      if (resultText) {
        return { type: 'text', text: resultText, raw }
      }
      return null
    }

    if (type === 'result') {
      const usage = (event as any).usage ?? {}
      const inputTokens = asNumber(usage.input_tokens)
      const outputTokens = asNumber(usage.output_tokens)
      const totalCost = asNumber((event as any).total_cost_usd)
      const sessionID = asString((event as any).session_id)
      return {
        type: 'cost',
        cost: {
          inputTokens,
          outputTokens,
          totalCost,
        },
        sessionID: sessionID || undefined,
        raw,
      }
    }

    return null
  }

  parseSessionID(events: DriverEvent[]): string | null {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const session = events[i]?.sessionID?.trim()
      if (session) return session
    }
    return null
  }
}

function normalizeAllowed(input: string[] | string | undefined): string[] {
  if (!input) return []
  if (Array.isArray(input)) {
    return dedupe(input.map((item) => item.trim()).filter(Boolean))
  }
  return dedupe(
    input.split(',').map((item) => item.trim()).filter(Boolean),
  )
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}

function toolKey(parsed: unknown): string {
  const obj = parsed as any
  return asString(obj.content_block?.id) || String(obj.index ?? '')
}

function unwrapStreamEnvelope(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object') return parsed
  const obj = parsed as Record<string, unknown>
  if (asString(obj.type) !== 'stream_event') {
    return parsed
  }
  const event = obj.event
  if (!event || typeof event !== 'object') {
    return parsed
  }
  return event
}

function parseJSON(raw: string): any | null {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}
