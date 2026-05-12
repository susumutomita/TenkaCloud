/**
 * Competitor Account の ExternalId rotation 経過日数を計算する (Issue #596 / ADR-002 Phase 3.1)。
 *
 * `rotatedAt` が存在すればそれ基準、無ければ `createdAt` 基準。ms → 日数に丸める
 * (= floor。「過去 1 日未満」の row は 0 日で表示する)。
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** rotation 経過を warning にする閾値 (= 90 日を超えたら yellow badge)。 */
export const ROTATION_AGE_WARNING_DAYS = 90;

export interface RotationAgeInput {
  readonly createdAt: string;
  readonly rotatedAt?: string;
  readonly nowMs: number;
}

export interface RotationAgeResult {
  readonly ageDays: number;
  /** `rotatedAt` ベースなら true、`createdAt` fallback なら false。 */
  readonly hasRotated: boolean;
  readonly isStale: boolean;
}

/**
 * `rotatedAt` (無ければ `createdAt`) と `nowMs` の差から経過日数を返す。
 * 不正な ISO 文字列は `NaN` を返さず 0 日として扱う (= UI で誤表示しないため)。
 */
export function computeRotationAge(input: RotationAgeInput): RotationAgeResult {
  const baseIso = input.rotatedAt ?? input.createdAt;
  const baseMs = Date.parse(baseIso);
  if (!Number.isFinite(baseMs)) {
    return { ageDays: 0, hasRotated: Boolean(input.rotatedAt), isStale: false };
  }
  const diffMs = Math.max(0, input.nowMs - baseMs);
  const ageDays = Math.floor(diffMs / MS_PER_DAY);
  return {
    ageDays,
    hasRotated: Boolean(input.rotatedAt),
    isStale: ageDays > ROTATION_AGE_WARNING_DAYS,
  };
}
