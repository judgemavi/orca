function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export type ParsedInteractionOutput = {
  result: string | null;
  output: string | null;
  data: Record<string, unknown> | null;
};

function parseInteractionOutput(
  rawOutput?: string | null,
): ParsedInteractionOutput | null {
  if (!rawOutput?.trim()) return null;

  try {
    const parsed = asRecord(JSON.parse(rawOutput));
    if (!parsed) return null;

    const parsedData = asRecord(parsed.data);
    const data: Record<string, unknown> = parsedData ? { ...parsedData } : {};

    for (const [key, value] of Object.entries(parsed)) {
      if (key === 'result' || key === 'data') continue;
      if (key === 'output') {
        if (typeof value === 'string' && value.trim() && data.output == null) {
          data.output = value;
        }
        continue;
      }
      data[key] = value;
    }

    const output =
      typeof parsed.output === 'string' && parsed.output.trim()
        ? parsed.output
        : typeof data.output === 'string' && data.output.trim()
          ? data.output
          : null;

    return {
      result: typeof parsed.result === 'string' ? parsed.result : null,
      output,
      data: Object.keys(data).length > 0 ? data : null,
    };
  } catch {
    return null;
  }
}

export function parseInteractionOutputData(
  rawOutput?: string | null,
): Record<string, unknown> | null {
  return parseInteractionOutput(rawOutput)?.data ?? null;
}

export function parseInteractionOutputResult(
  rawOutput?: string | null,
): string | null {
  return parseInteractionOutput(rawOutput)?.result ?? null;
}
