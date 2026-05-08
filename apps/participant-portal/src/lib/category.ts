import type { ParticipantScoringInfo } from "../api/portal-client";

export type ProblemCategory = "battle" | "challenge";

/**
 * scoring.kind から「Battle / Challenge」表示用カテゴリを推定する。
 * 現状の運用 (1 problem は uptime か flag いずれか単独) では:
 *   - `uptime` → Battle (= 防御問題)
 *   - `flag`   → Challenge (= CTF)
 *
 * 将来 1 problem が両方の scoring を持つようになる場合 (Battle 内 sub-quest 等、
 * Issue #502 注釈参照) は backend が metadata.json の `category` を view に流す
 * 形に切り替える。
 */
export function categoryOf(scoring: ParticipantScoringInfo | undefined): ProblemCategory | null {
  if (!scoring) return null;
  return scoring.kind === "uptime" ? "battle" : "challenge";
}
