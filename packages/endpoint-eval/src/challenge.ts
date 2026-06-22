import type { StageDefinition } from "./stage.js";
import type { TargetPolicy } from "./target-guard.js";

/**
 * Issue #1973: 1 つのチャレンジ定義 (= 問題 plugin)。 engine は問題を知らず、 この
 * **データ** を受け取って実行する。 隠しテスト (probes) と targetPolicy はここに宿り、
 * server-side にのみ置く (= 参加者リポジトリには出さない = 信頼境界)。
 */
export interface ChallengeDefinition {
  readonly id: string;
  readonly title: string;
  /** この問題アプリをどこで動かしてよいか (= SSRF policy)。 */
  readonly targetPolicy: TargetPolicy;
  readonly stages: readonly StageDefinition[];
  /**
   * run の seed から probe 置換値を導出する (省略時は空)。 「テスト入力を run ごとに変える」
   * ために使う。 {@link seededValue} を使うと決定的かつ run 間で異なる値になる。
   */
  readonly makeRunValues?: (seed: string) => Record<string, string>;
}

/** 参加者へ公開してよい stage の概要 (probes / 期待値は含めない)。 */
export interface PublicStageInfo {
  readonly id: string;
  readonly title: string;
}

/** チャレンジから参加者公開用の安全な stage 一覧を作る (隠しテストは落とす)。 */
export function publicStages(challenge: ChallengeDefinition): PublicStageInfo[] {
  return challenge.stages.map((s) => ({ id: s.id, title: s.title }));
}
