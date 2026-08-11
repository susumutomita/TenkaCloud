import type { DeploymentItem } from "../deploy-handler/types.js";
import { isRoundTerminated } from "./round-liveness.js";

/**
 * deployment が採点対象かを判定。`eventStartsAt` が未設定 / 未来なら false。
 * - 未設定: 旧 jobId-based deployment / Event.startsAt 未設定 → 採点無し
 * - 未来: operator が schedule 済だがまだ時刻に到達していない → skip
 * - 終了済み: round が終端に達したら skip。 `eventEndsAt` 明示があればそれ、 無くても
 * `eventStartsAt + MAX_ROUND_DURATION_MINUTES` で必ず終端する (#1421 liveness invariant
 *   "every round reaches a terminal state" — endsAt 付け忘れ round の無限採点を構造的に排除)。
 * 比較は ISO8601 文字列の辞書順比較で安全 (UTC ISO は時系列ソート可能)。
 *
 * dispatcher と health-check-handler が同じ判定を共有する。
 */
export function isScoringActive(
  item: Pick<DeploymentItem, "eventStartsAt" | "eventEndsAt">,
  nowIso: string,
): boolean {
  if (typeof item.eventStartsAt !== "string") return false;
  if (nowIso < item.eventStartsAt) return false;
  if (isRoundTerminated(item, nowIso)) return false;
  return true;
}
