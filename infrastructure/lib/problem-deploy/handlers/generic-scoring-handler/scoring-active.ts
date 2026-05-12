import type { DeploymentItem } from "../deploy-handler/types.js";

/**
 * deployment が採点対象かを判定。`eventStartsAt` が未設定 / 未来なら false。
 * - 未設定: 旧 jobId-based deployment / Event.startsAt 未設定 → 採点無し
 * - 未来: operator が schedule 済だがまだ時刻に到達していない → skip
 * - 終了済み: `eventEndsAt` が設定されていて now >= eventEndsAt → skip (Issue #494)
 * 比較は ISO8601 文字列の辞書順比較で安全 (UTC ISO は時系列ソート可能)。
 *
 * health-check-handler から ADR-012 Phase 3.B で本 module へ relocate (= dispatcher が gate
 * として使う、責務は不変)。
 */
export function isScoringActive(
  item: Pick<DeploymentItem, "eventStartsAt" | "eventEndsAt">,
  nowIso: string,
): boolean {
  if (typeof item.eventStartsAt !== "string") return false;
  if (nowIso < item.eventStartsAt) return false;
  if (typeof item.eventEndsAt === "string" && nowIso >= item.eventEndsAt) return false;
  return true;
}
