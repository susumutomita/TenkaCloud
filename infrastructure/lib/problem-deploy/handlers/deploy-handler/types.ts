import { z } from "zod";

/**
 * POST /problems/:problemId/deploy のリクエスト body。
 *
 * UI 側 DeployFormModal が送る shape と一致させる。
 *
 * forward-compat: `accountGroupId` / `problemSetId` は将来の bulk deploy 機能で使う。
 * 現状は単発 deploy なので optional のまま受け付け、無視する。
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

export type DeploymentStatus =
  | "PENDING"
  | "IN_PROGRESS"
  | "COMPLETE"
  | "FAILED"
  | "DELETING"
  | "DELETED";

/**
 * Deployments テーブルの行 (DocumentClient shape)。
 *
 * PK = `DEPLOYMENT#<jobId>` / SK = `META`
 * GSI1PK = `TENANT#<tenantId>` / GSI1SK = `<createdAt>` (ISO8601、テナント別ソート用)
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
  /** 短命キー (deploy 直後の API レスポンスで TenantAdmin に 1 度だけ表示する想定) */
  teamLoginKey: string;
  status: DeploymentStatus;

  /** PR-D 以降で worker が埋める */
  stackId?: string;
  /** PR-E 以降で StatusUpdater が CFn Outputs を JSON 文字列で書き戻す */
  stackOutputs?: string;
  failureReason?: string;

  createdAt: string;
  updatedAt: string;
  /** TTL 属性 (epoch seconds、auto-teardown 用) */
  expiresAt: number;

  /** forward-compat: 将来 bulk deploy 機能で使う */
  accountGroupId?: string;
  problemSetId?: string;
}

export const DeployResponseSchema = z.object({
  jobId: z.string(),
  status: z.string(),
  namePrefix: z.string(),
  teamLoginKey: z.string(),
  expiresAt: z.number(),
});
export type DeployResponse = z.infer<typeof DeployResponseSchema>;

export interface DeployRequestedDetail {
  jobId: string;
  problemId: string;
  tenantId: string;
  awsAccountId: string;
  region: string;
  teamName: string;
  namePrefix: string;
}
