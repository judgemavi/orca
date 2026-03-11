import type { OrcaDrizzleDB } from '../db/connection';
import {
  buildMemoryContext,
  retrieveBudgetedMemory,
} from '../domain/memory-retrieval';
import type { MemoryStore } from '../store/memory';
import type { TaskContextSection } from './types';

export async function buildTaskContextSection(
  memoryStore: MemoryStore,
  db: OrcaDrizzleDB,
  taskID: string,
  title: string,
  description: string,
): Promise<TaskContextSection> {
  const result = await retrieveBudgetedMemory(memoryStore, db, {
    taskId: taskID,
    title,
    description,
  });
  const context = buildMemoryContext(result);

  const usedMemoryIDs: string[] = [];
  const usedProvenanceHashes: string[] = [];
  const allEntries = [
    ...(result.summary ? [result.summary] : []),
    ...result.exactMatches,
    ...result.semanticMatches,
    ...result.recencyMatches,
  ];

  for (const entry of allEntries) {
    usedMemoryIDs.push(entry.id);
    if (entry.provenanceHash) {
      usedProvenanceHashes.push(entry.provenanceHash);
    }
  }

  return { context, usedMemoryIDs, usedProvenanceHashes };
}
