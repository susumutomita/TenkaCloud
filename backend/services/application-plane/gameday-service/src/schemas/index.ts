import { z } from 'zod';

// 共通: eventId のみのリクエスト
export const eventIdSchema = z.object({
  eventId: z.string().min(1),
});

// 管理者: ゲーム開始
export const startGameSchema = z.object({
  eventId: z.string().min(1),
  durationMinutes: z.number().int().min(1).max(480).default(240),
});

// 管理者: 障害注入
export const faultInjectionSchema = z.object({
  eventId: z.string().min(1),
  teamId: z.string().min(1),
  attackSlug: z.string().min(1),
});

// 管理者: 攻撃カタログシード
export const seedAttacksSchema = z.object({
  eventId: z.string().min(1),
});

// プレーヤー: 攻撃購入
export const purchaseAttackSchema = z.object({
  eventId: z.string().min(1),
  teamId: z.string().min(1),
  attackId: z.string().min(1),
});

// プレーヤー: 攻撃実行
export const executeAttackSchema = z.object({
  eventId: z.string().min(1),
  teamId: z.string().min(1),
  attackId: z.string().min(1),
  targetTeamId: z.string().min(1),
});

// プレーヤー: ヒント購入
export const purchaseHintSchema = z.object({
  eventId: z.string().min(1),
  teamId: z.string().min(1),
  attackId: z.string().min(1),
});

// プレーヤー: 脆弱性修正報告
export const reportFixSchema = z.object({
  eventId: z.string().min(1),
  teamId: z.string().min(1),
  vulnerabilitySlug: z.string().min(1),
});

// プレーヤー: 同盟申請
export const requestAllianceSchema = z.object({
  eventId: z.string().min(1),
  teamId: z.string().min(1),
  targetTeamId: z.string().min(1),
});

// プレーヤー: 同盟承認/破棄
export const allianceActionSchema = z.object({
  eventId: z.string().min(1),
  teamId: z.string().min(1),
});

// プレーヤー: 投票
export const voteSchema = z.object({
  eventId: z.string().min(1),
  teamId: z.string().min(1),
  votedForTeamId: z.string().min(1),
});
