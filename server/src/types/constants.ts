// Domain enums not in DB schema
export const MEMORY_CATEGORIES = [
  'pattern',
  'pitfall',
  'preference',
  'convention',
  'architecture',
  'dependency',
  'tooling',
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const MEMORY_SOURCE_TYPES = ['retro', 'explore'] as const;
export type MemorySourceType = (typeof MEMORY_SOURCE_TYPES)[number];

/** Categories representing durable structural knowledge — exempt from time-based decay by default. */
export const STRUCTURAL_CATEGORIES: ReadonlySet<MemoryCategory> = new Set([
  'architecture',
  'convention',
  'tooling',
  'dependency',
]);
