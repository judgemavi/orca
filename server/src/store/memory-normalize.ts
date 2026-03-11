import type { MemorySourceType } from '../types/constants';

export function nullable(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? '';
  return normalized || null;
}

export function normalizeSourceType(
  value: string | null | undefined,
): MemorySourceType {
  const normalized = (value ?? 'retro').trim().toLowerCase();
  if (normalized === 'retro' || normalized === 'explore') {
    return normalized;
  }
  throw new Error(`invalid sourceType ${JSON.stringify(value)}`);
}

export function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b),
  );
}

export function normalizePaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => path.trim()).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b),
  );
}

export function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((tag) => String(tag)).filter(Boolean);
  }

  if (typeof raw === 'string') {
    if (!raw.trim()) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((tag) => String(tag)).filter(Boolean);
      }
    } catch {
      return [];
    }
  }

  return [];
}
