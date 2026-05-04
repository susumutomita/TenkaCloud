import { z } from "zod";

export {
  type DeployRequestedDetail,
  DeployRequestedDetailSchema,
  EVENT_DETAIL_TYPE_DEPLOY_REQUESTED,
  EVENT_SOURCE,
} from "../shared/events.js";

export const DeploymentStatusSchema = z.enum([
  "PENDING",
  "IN_PROGRESS",
  "COMPLETE",
  "FAILED",
  "DELETING",
  "DELETED",
]);
export type DeploymentStatus = z.infer<typeof DeploymentStatusSchema>;

/**
 * `POST /problems/:problemId/deploy` のリクエスト body。UI 側 DeployFormModal と
 * 一致させる。`accountGroupId` / `problemSetId` は bulk deploy 用の予約フィールドで、
 * 現状は受け取って DDB に保存するのみ (worker 側では未使用)。
 */
export const DeployRequestSchema = z.object({
  region: z.string().regex(/^[a-z]{2}-[a-z]+-\d+$/, "AWS region 形式が不正です"),
  awsAccountId: z.string().regex(/^\d{12}$/, "AWS Account ID は 12 桁の数字"),
  teamName: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[A-Za-z0-9 _-]+$/, "Team Name は英数字 / スペース / _ / - のみ、40 文字以内"),
  accountGroupId: z.string().optional(),
  problemSetId: z.string().optional(),
});
export type DeployRequest = z.infer<typeof DeployRequestSchema>;

/**
 * Deployments テーブルの行 (DocumentClient shape)。
 *
 *   PK     = `DEPLOYMENT#<jobId>` / SK = `META`
 *   GSI1PK = `TENANT#<tenantId>` / GSI1SK = `<createdAt>` (ISO8601、テナント別ソート用)
 */
export interface DeploymentItem {
  PK: string;
  SK: "META";
  GSI1PK: string;
  GSI1SK: string;

  jobId: string;
  problemId: string;
  tenantId: string;
  awsAccountId: string;
  region: string;
  teamName: string;
  namePrefix: string;
  /** 短命キー。API レスポンスで TenantAdmin に 1 度だけ露出し、以降は DDB 内に閉じる。 */
  teamLoginKey: string;
  status: DeploymentStatus;

  /** worker (CFn 起動側) が埋める */
  stackId?: string;
  /** StatusUpdater が CFn Outputs を JSON 文字列で書き戻す */
  stackOutputs?: string;
  failureReason?: string;

  createdAt: string;
  updatedAt: string;
  /** TTL 属性 (epoch seconds)。auto-teardown のキー。 */
  expiresAt: number;

  /** Reserved for bulk deploy. */
  accountGroupId?: string;
  problemSetId?: string;
}

export const DeployResponseSchema = z.object({
  jobId: z.string(),
  status: DeploymentStatusSchema,
  namePrefix: z.string(),
  teamLoginKey: z.string(),
  expiresAt: z.number(),
});
export type DeployResponse = z.infer<typeof DeployResponseSchema>;
