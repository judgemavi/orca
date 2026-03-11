type OutputData = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

type ParsedWorkflowOutput = {
  result: string | null;
  output: string;
  data: OutputData;
};

export function parseWorkflowOutput(
  rawOutput?: string | null,
): ParsedWorkflowOutput | null {
  if (!rawOutput?.trim()) return null;

  try {
    const parsed = asRecord(JSON.parse(rawOutput));
    if (!parsed) return null;

    const parsedData = asRecord(parsed.data);
    const data: OutputData = parsedData ? { ...parsedData } : {};

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
      typeof parsed.output === 'string'
        ? parsed.output
        : typeof data.output === 'string'
          ? data.output
          : '';

    return {
      result: typeof parsed.result === 'string' ? parsed.result : null,
      output,
      data,
    };
  } catch {
    return null;
  }
}

export function stringifyWorkflowOutput(args: {
  result: string;
  output?: string;
  data?: OutputData;
}): string {
  const data = args.data ? { ...args.data } : {};
  const output =
    typeof args.output === 'string'
      ? args.output
      : typeof data.output === 'string'
        ? data.output
        : '';

  if (output && data.output == null) {
    data.output = output;
  }

  return JSON.stringify({
    result: args.result,
    output,
    ...(Object.keys(data).length > 0 ? { data } : {}),
  });
}

export function extractWorkflowOutput(rawOutput?: string | null): string {
  return (
    parseWorkflowOutput(rawOutput)?.output.trim() ?? rawOutput?.trim() ?? ''
  );
}
