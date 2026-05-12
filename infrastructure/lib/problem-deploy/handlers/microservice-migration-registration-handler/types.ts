import { z } from "zod";
import {
  MICROSERVICE_MIGRATION_PROBLEM_ID,
  MICROSERVICE_MIGRATION_SLOTS,
  type MicroserviceMigrationSlot,
} from "../microservice-migration-poller-handler/scoring.js";

/**
 * `MicroserviceMigrationScoresTable` 1 行の shape (Issue #606 / Phase 2)。
 *
 *   PK = `TENANT#<tenantId>#PROBLEM#microservice-migration-battle`
 *   SK = `SLOT#<users|orders|catalog>`
 *
 * 競技者が登録した移行先 endpoint と、polling Lambda の最新観測結果を持つ単一の行。
 * 採点 event 自体は既存 `ScoreEvent` ストリーム経由 (Deployments テーブル) で発行する。
 *
 * 全 slot で `platform != "ec2"` を達成した瞬間に +5000 lump-sum bonus を一度だけ発行する
 * (二重発行防止のため `fullMigrationBonusAwarded` を立てる)。
 */
export interface MicroserviceMigrationScoreItem {
  PK: string;
  SK: string;

  tenantId: string;
  problemId: typeof MICROSERVICE_MIGRATION_PROBLEM_ID;
  slot: MicroserviceMigrationSlot;
  /** 競技者が `POST /problems/microservice-migration-battle/endpoints` で登録した URL。 */
  registeredUrl: string;
  /** 登録時刻 (ISO 8601)。 */
  registeredAt: string;
  /** 登録ユーザー (Cognito sub)。観測 / 監査用。 */
  registeredBy?: string;

  // polling Lambda が書き込む結果。初回 probe 前は undefined。
  /** 直近 probe の時刻 (ISO 8601)。 */
  lastProbeAt?: string;
  /** /meta `platform` の自己申告値 (= 直近観測)。 */
  platform?: string;
  /** 直近 probe の集約結果 (ok / fail / timeout 等の短い名前)。 */
  lastResult?: "ok" | "fail" | "timeout";
  /** 直近 probe の score 加減算ポイント (= ScoreEvent と整合)。 */
  lastPoints?: number;
  /** 直近 probe の `/score` レスポンスタイム (ms)。 */
  lastResponseTimeMs?: number;

  /** 3 slot 全分離 +5000 bonus を発行済か (tenant 全体で 1 度のみ)。 */
  fullMigrationBonusAwarded?: boolean;
}

const URL_MAX_LEN = 2_048;
const HTTP_URL_RE = /^https?:\/\/[^\s]{1,2046}$/i;

const SlotEnum = z.enum(MICROSERVICE_MIGRATION_SLOTS);

export const RegisterEndpointRequestSchema = z
  .object({
    slot: SlotEnum,
    url: z
      .string()
      .min(1)
      .max(URL_MAX_LEN)
      .regex(HTTP_URL_RE, "URL は http(s):// で始まる絶対 URL を指定してください"),
  })
  .strict();
export type RegisterEndpointRequest = z.infer<typeof RegisterEndpointRequestSchema>;

export interface RegisterEndpointResponse {
  readonly slot: MicroserviceMigrationSlot;
  readonly registeredUrl: string;
  readonly registeredAt: string;
}

export interface ListEndpointsResponse {
  readonly items: ReadonlyArray<{
    readonly slot: MicroserviceMigrationSlot;
    readonly registeredUrl: string;
    readonly registeredAt: string;
    readonly platform?: string;
    readonly lastResult?: "ok" | "fail" | "timeout";
    readonly lastProbeAt?: string;
    readonly lastPoints?: number;
    readonly lastResponseTimeMs?: number;
  }>;
}

export function buildScorePk(tenantId: string): string {
  return `TENANT#${tenantId}#PROBLEM#${MICROSERVICE_MIGRATION_PROBLEM_ID}`;
}

export function buildScoreSk(slot: MicroserviceMigrationSlot): string {
  return `SLOT#${slot}`;
}
