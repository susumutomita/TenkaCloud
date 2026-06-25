import { z } from "zod";
import type { HintRevealRecord } from "../deploy-handler/types.js";

/**
 * Issue #742: progressive hint reveal の DDB attribute (= `hintsRevealed`) parser。
 *
 * DDB structural 変更は不要 (= schemaless、 attribute を新規追加するだけ)。
 *
 * 公開する surface:
 *   - HintRevealRecordSchema: Zod schema (= API 入出力 / DDB 読み込みの validation 用)
 *   - parseHintRevealedAttribute: DDB attribute (unknown) を安全に narrow
 */

export const HintRevealRecordSchema = z.object({
  hintId: z.string().min(1),
  revealedAt: z.string().min(1),
  penaltyApplied: z.number().int().min(0),
});

/**
 * DDB の `hintsRevealed` attribute を unknown から安全に narrow する。 旧 row (= 本 attribute
 * 不在) は空配列扱い。 不正な要素を含む配列は filter で skip (= partial 不正でも全体 reject
 * しない、 #742 Phase 1 の parser と同じ defensive 思想)。
 */
export function parseHintRevealedAttribute(value: unknown): readonly HintRevealRecord[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [];
  const records: HintRevealRecord[] = [];
  for (const raw of value) {
    const parsed = HintRevealRecordSchema.safeParse(raw);
    if (parsed.success) records.push(parsed.data);
  }
  return records;
}
