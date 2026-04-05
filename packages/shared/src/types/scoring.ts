/**
 * Unified Scoring Schema
 *
 * ADR-003: 統一スコアリングスキーマとポイント経済
 * GameDay と JAM で共通のスコアイベント型と定数を定義
 */

// =============================================================================
// Score Event Types
// =============================================================================

/**
 * スコアイベントカテゴリ
 */
export type ScoreEventCategory =
  | 'attack_success'
  | 'attack_blocked'
  | 'defense_fix'
  | 'hint_purchase'
  | 'attack_purchase'
  | 'challenge_solve'
  | 'clue_reveal'
  | 'health_check_pass'
  | 'initial_points';

/**
 * 統一スコアイベント型
 *
 * GameDay / JAM 共通のスコア変動イベント
 */
export interface ScoreEvent {
  /** イベントID */
  eventId: string;
  /** チームID */
  teamId: string;
  /** ユーザーID */
  userId: string;
  /** スコアカテゴリ */
  category: ScoreEventCategory;
  /** ポイント（正 = 獲得、負 = 消費） */
  points: number;
  /** メタデータ */
  metadata: Record<string, unknown>;
  /** タイムスタンプ */
  timestamp: string;
}

// =============================================================================
// GameDay Point Economy
// =============================================================================

/**
 * GameDay ポイント経済定数
 */
export const GAMEDAY_POINTS = {
  /** ゲーム開始時の初期ポイント */
  INITIAL: 10_000,
  /** 攻撃購入コスト */
  ATTACK_PURCHASE: -3_000,
  /** 攻撃成功報酬 */
  ATTACK_SUCCESS: 1_000,
  /** 攻撃被弾ダメージ */
  ATTACK_HIT: -1_000,
  /** 防御成功（脆弱性修正）報酬 */
  DEFENSE_FIX: 1_500,
  /** ヒント購入コスト範囲 */
  HINT_COST_MIN: -500,
  HINT_COST_MAX: -3_000,
  /** ヘルスチェック合格報酬 */
  HEALTH_CHECK_PASS: 200,
} as const;

// =============================================================================
// JAM Point Economy
// =============================================================================

/**
 * JAM ポイント経済定数
 */
export const JAM_POINTS = {
  /** 問題正解ポイント範囲 */
  SOLVE_MIN: 100,
  SOLVE_MAX: 1_000,
  /** ヒント使用時のペナルティ（正解ポイントからの減額率） */
  HINT_PENALTY_RATE: 0.2,
  /** 早解きボーナス率 */
  EARLY_SOLVE_BONUS_RATE: 0.1,
} as const;

// =============================================================================
// Helpers
// =============================================================================

/**
 * ScoreEvent を作成するヘルパー
 */
export function createScoreEvent(
  params: Omit<ScoreEvent, 'timestamp'>,
): ScoreEvent {
  return {
    ...params,
    timestamp: new Date().toISOString(),
  };
}

/**
 * スコアイベントのポイント合計を計算
 */
export function calculateTotalScore(events: ScoreEvent[]): number {
  return events.reduce((total, event) => total + event.points, 0);
}
