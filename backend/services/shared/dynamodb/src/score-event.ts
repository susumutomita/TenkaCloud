/**
 * ScoreEvent — 統一スコアリングスキーマ (ADR-003)
 *
 * GameDay のポイント経済を一元管理する型定義。
 * すべてのスコア変動はこの型で記録される。
 */

export const ScoreCategory = {
  ATTACK_SUCCESS: 'attack_success',
  ATTACK_BLOCKED: 'attack_blocked',
  DEFENSE_FIX: 'defense_fix',
  HINT_PURCHASE: 'hint_purchase',
  ATTACK_PURCHASE: 'attack_purchase',
  CHALLENGE_SOLVE: 'challenge_solve',
  CLUE_REVEAL: 'clue_reveal',
  HEALTH_CHECK_PASS: 'health_check_pass',
  INITIAL_POINTS: 'initial_points',
} as const;

export type ScoreCategory =
  (typeof ScoreCategory)[keyof typeof ScoreCategory];

export interface ScoreEvent {
  eventId: string;
  teamId: string;
  userId: string;
  category: ScoreCategory;
  /** positive = earned, negative = spent */
  points: number;
  metadata: Record<string, unknown>;
  timestamp: string;
}

/**
 * GameDay ポイント経済定数 (ADR-003)
 */
export const POINT_ECONOMY = {
  /** ゲーム開始時の初期ポイント */
  INITIAL_POINTS: 10_000,
  /** 攻撃購入コスト */
  ATTACK_PURCHASE: -3_000,
  /** 攻撃成功報酬 */
  ATTACK_SUCCESS: 1_000,
  /** 攻撃被弾ダメージ */
  ATTACK_RECEIVED: -1_000,
  /** 防御修正報酬 */
  DEFENSE_FIX: 1_500,
  /** ヒント購入コスト（最小） */
  HINT_PURCHASE_MIN: -500,
  /** ヒント購入コスト（最大） */
  HINT_PURCHASE_MAX: -3_000,
  /** ヘルスチェック通過報酬 */
  HEALTH_CHECK_PASS: 200,
} as const;
