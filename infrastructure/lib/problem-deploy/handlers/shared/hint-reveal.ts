import { z } from "zod";
import type { HintRevealRecord } from "../deploy-handler/types.js";

/**
 * Issue #742 Phase 2: progressive hint reveal の DDB attribute (= `hintsRevealed`) 用 helper。
 *
 * Phase 2 はあくまで type + helper の追加のみ (= 実 reveal は Phase 3 の API で行う)。
 * DDB structural 変更は不要 (= schemaless、 attribute を新規追加するだけ)。
 *
 * 公開する surface:
 *   - HintRevealRecordSchema: Zod schema (= API 入出力 / DDB 読み込みの validation 用)
 *   - isHintRevealed: idempotency check
 *   - findHintReveal: 既存 reveal 記録の参照
 *   - parseHintRevealedAttribute: DDB attribute (unknown) を安全に narrow
 */

export const HintRevealRecordSchema = z.object({
  hintId: z.string().min(1),
  revealedAt: z.string().min(1),
  penaltyApplied: z.number().int().min(0),
});

export const HintRevealedAttributeSchema = z.array(HintRevealRecordSchema);

/**
 * 同 hintId が既に reveal 済みか判定する (= API の idempotent 動作で、 重複 reveal を
 * no-op にするための条件)。
 */
export function isHintRevealed(
  records: readonly HintRevealRecord[] | undefined,
  hintId: string,
): boolean {
  if (!records) return false;
  return records.some((r) => r.hintId === hintId);
}

/**
 * 既存 reveal 記録から hintId に対応する record を返す。 重複していたら最初の 1 件を返す
 * (= reveal は idempotent なので原理上 1 件しか存在しないが、 過去 bug で重複が紛れ込んでも
 * 壊れないように防御)。
 */
export function findHintReveal(
  records: readonly HintRevealRecord[] | undefined,
  hintId: string,
): HintRevealRecord | undefined {
  if (!records) return undefined;
  return records.find((r) => r.hintId === hintId);
}

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

/**
 * Phase 3 で API が使う想定の helper: 既存 records に新規 reveal を idempotent に append する。
 * 同 hintId が既にあれば既存 records を変更せずに返す (= caller は no-op を識別可能、
 * 戻り値 changed=false で API が 304 / 200 の判断をする)。
 */
export interface AppendHintRevealResult {
  readonly changed: boolean;
  readonly records: readonly HintRevealRecord[];
  /** changed=true のとき、 今回 append した record。 changed=false のとき undefined。 */
  readonly appended: HintRevealRecord | undefined;
}

export function appendHintReveal(
  existing: readonly HintRevealRecord[] | undefined,
  next: HintRevealRecord,
): AppendHintRevealResult {
  const records = existing ?? [];
  if (isHintRevealed(records, next.hintId)) {
    return { changed: false, records, appended: undefined };
  }
  return { changed: true, records: [...records, next], appended: next };
}
