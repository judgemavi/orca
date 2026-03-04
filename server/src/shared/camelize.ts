/**
 * Recursively converts snake_case keys to camelCase.
 * Handles nested objects and arrays.
 * Used to normalize LLM JSON output across different providers
 * (Claude returns camelCase, Codex/others may return snake_case).
 */
export function camelizeKeys<T>(obj: T): T {
  if (Array.isArray(obj)) {
    return obj.map((item) => camelizeKeys(item)) as T;
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const camelKey = key.replace(/_([a-z])/g, (_, letter) =>
        letter.toUpperCase(),
      );
      result[camelKey] = camelizeKeys(value);
    }
    return result as T;
  }
  return obj;
}
