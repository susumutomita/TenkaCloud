import type { ProblemCategory as CatalogCategory } from "@tenkacloud/portal-contracts";
import type { ParticipantScoringInfo, ScoringKind } from "../api/portal-client";

export type ProblemCategory = "battle" | "challenge";

/**
 * scoring.kind から Battle / Challenge 表示用カテゴリを推定する。 problem metadata で定義された
 * 5 種の builtin kind を 2 軸に collapse する:
 *
 *   - `flag`             -> challenge (= CTF / 1-shot 提出)
 *   - `uptime` (= alias) -> battle    (= legacy、 Phase 1 互換)
 *   - `uptime-flat`      -> battle    (= 単一 endpoint uptime 監視)
 *   - `uptime-multi`     -> battle    (= 複数 endpoint uptime 監視)
 *   - `phased-polling`   -> battle    (= microservice-migration-battle 等、 時間経過で採点 ruleが変化)
 *   - `attack-detection` -> battle    (= 攻撃/防御 detection)
 *
 * Issue #688: phased-polling を challenge に誤分類していた regression を修正。
 * 旧 logic は `kind === "uptime" ? battle : challenge` で battle 軸の新 kind が
 * すべて challenge に流れていた。
 *
 * `scoring` の無い coordination 問題 (暗号 Battle など) だけ、 catalog metadata の `category` を使う。
 */
const BATTLE_KINDS: ReadonlySet<ScoringKind> = new Set<ScoringKind>([
  "uptime",
  "uptime-flat",
  "uptime-multi",
  "phased-polling",
  "attack-detection",
]);

export function categoryOf(
  scoring: ParticipantScoringInfo | undefined,
  catalogCategory?: CatalogCategory,
): ProblemCategory | null {
  if (scoring) return BATTLE_KINDS.has(scoring.kind) ? "battle" : "challenge";
  if (catalogCategory === "Battle") return "battle";
  if (catalogCategory === "Challenge") return "challenge";
  return null;
}
