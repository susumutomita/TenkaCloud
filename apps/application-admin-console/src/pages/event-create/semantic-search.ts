import type { advisorCatalog } from "./problem-advisor";
export const EMBEDDING_MODEL = "onnx-community/embeddinggemma-2-ONNX";
export const EMBEDDING_REVISION = "daa72c51243991dfcaf9f9137d2c573d8f7790c0";
export type SemanticCandidate = ReturnType<typeof advisorCatalog>[number];
export function semanticDocument(p: SemanticCandidate) {
  return `title: ${p.name} | text: ${p.summary}\n学習目標: ${p.goals.join(" / ")}\nテーマ: ${p.tags.join(", ")}`;
}
export function normalizeVector(vector: number[]) {
  if (vector.length !== 768 || vector.some((v) => !Number.isFinite(v)))
    throw new Error("埋め込みが有効な768次元ではありません。");
  const norm = Math.hypot(...vector);
  if (!norm) throw new Error("埋め込みが空でした。");
  return vector.map((v) => v / norm);
}
export function rankSemantic(
  query: number[],
  vectors: { id: string; vector: number[] }[],
  allowed: ReadonlySet<string>,
) {
  const normalized = normalizeVector(query);
  return vectors
    .filter((v) => allowed.has(v.id))
    .map((v) => ({
      id: v.id,
      score: normalizeVector(v.vector).reduce((sum, n, i) => sum + n * normalized[i], 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}
