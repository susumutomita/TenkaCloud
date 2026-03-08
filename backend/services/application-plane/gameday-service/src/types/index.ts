// 攻撃種別
export type AttackType = 'vulnerability' | 'chaos';

// 同盟ステータス
export type AllianceStatus = 'PENDING' | 'ACTIVE';

// スコア重み
export type ScoreWeight = 'normal' | 'high';

// ゲームフェーズ
export interface GameState {
  eventId: string;
  tenantId: string;
  isRunning: boolean;
  startedAt: string | null;
  scoreWeight: ScoreWeight;
  blackout: boolean;
  durationMinutes: number;
}

// 攻撃カタログ
export interface Attack {
  id: string;
  name: string;
  slug: string;
  attackType: AttackType;
  targetVulnerability: string | null;
  description: string;
  purchaseCost: number;
  damage: number;
  reward: number;
  cooldownSeconds: number;
  defenseHint: string;
  hintCost: number;
}

// 攻撃購入
export interface AttackPurchase {
  id: string;
  teamId: string;
  attackId: string;
  purchasedAt: string;
  lastUsedAt: string | null;
}

// 攻撃ログ
export interface AttackLog {
  id: string;
  eventId: string;
  attackerTeamId: string;
  defenderTeamId: string;
  attackId: string;
  success: boolean;
  neutralized: boolean;
  damage: number;
  reward: number;
  details: string;
  createdAt: string;
}

// チーム脆弱性状態
export interface TeamVulnerability {
  id: string;
  eventId: string;
  teamId: string;
  vulnerabilitySlug: string;
  isFixed: boolean;
}

// 同盟
export interface Alliance {
  id: string;
  eventId: string;
  requesterTeamId: string;
  targetTeamId: string;
  status: AllianceStatus;
  createdAt: string;
  updatedAt: string;
}

// ヘルスチェック結果
export interface HealthCheckResult {
  id: string;
  eventId: string;
  teamId: string;
  checkType: 'website' | 'api';
  isHealthy: boolean;
  statusCode: number | null;
  responseTimeMs: number | null;
  createdAt: string;
}
