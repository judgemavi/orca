export function computeSalience(
  similarity: number,
  confidence: number,
  retrievalCount: number,
  updatedAt: string,
): number {
  const reinforcement = Math.min(
    1,
    Math.log1p(retrievalCount) / Math.log1p(10),
  );
  const ageMs = Date.now() - new Date(updatedAt).getTime();
  const recency = Math.max(0, 1 - ageMs / (30 * 24 * 60 * 60 * 1000));
  return round2(
    similarity * 0.5 + confidence * 0.2 + reinforcement * 0.15 + recency * 0.15,
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
