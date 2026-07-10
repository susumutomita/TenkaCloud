import { z } from "zod";
import type { DeploymentRecord, DeploymentStatus } from "../../control-data/domain/deployments.js";

// [Issue #2527 Slice 1 step 2] The domain module owns these shapes; this handler
// re-exports them so the 48 existing importers keep their import path.
export type {
  DeploymentStatus,
  HintRevealRecord,
} from "../../control-data/domain/deployments.js";
export type { DeploymentProvenance } from "../shared/deployment-provenance.js";
export {
  type DeployCreateRequestedDetail,
  DeployCreateRequestedDetailSchema,
  EVENT_DETAIL_TYPE_DEPLOY_CREATE_REQUESTED,
  EVENT_SOURCE,
} from "../shared/events.js";

export const DeploymentStatusSchema = z.enum([
  "PENDING",
  /**
   * Issue #2019 / ADR-017: a high-risk deploy that TrustBridge enforcement held
   * pending operator approval. The deployment row exists, but **no AssumeRole /
   * CloudFormation has run** — the worker was never invoked. Lives between
   * `PENDING` (created) and `IN_PROGRESS` (worker running), and is treated like
   * `PENDING` for retention / scoring / event auto-transition (= held in-flight,
   * not terminal). Only reached when `CLOUD_ACTION_ENFORCEMENT_MODE=enforce` and
   * a matching high-risk rule fires; the default (`shadow`) never produces it.
   */
  "APPROVAL_PENDING",
  "IN_PROGRESS",
  "COMPLETE",
  "FAILED",
  "DELETING",
  "DELETED",
  "EXPIRED",
  "AUTO_DELETED",
]);

// [Issue #2527 Slice 1 step 2] Compile-time lock-step guard: the validation enum
// and the domain `DeploymentStatus` union must stay identical (either drifting
// direction fails typecheck).
type _MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _deploymentStatusLockstep: _MutuallyAssignable<
  z.infer<typeof DeploymentStatusSchema>,
  DeploymentStatus
> = true;

/**
 * `POST /problems/:problemId/deploy` のリクエスト body。UI 側 DeployFormModal と
 * 一致させる。`accountGroupId` / `problemSetId` は bulk deploy 用の予約フィールドで、
 * 現状は受け取って DDB に保存するのみ (worker 側では未使用)。
 */
const AWS_REGION_RE = /^[a-z]{2}-[a-z]+-\d+$/;
const AWS_ACCOUNT_ID_RE = /^\d{12}$/;
const TEAM_NAME_RE = /^[A-Za-z0-9 _-]+$/;

const teamNameSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(TEAM_NAME_RE, "Team Name は英数字 / スペース / _ / - のみ、40 文字以内");

export const DeployRequestSchema = z.object({
  region: z.string().regex(AWS_REGION_RE, "AWS region 形式が不正です"),
  awsAccountId: z.string().regex(AWS_ACCOUNT_ID_RE, "AWS Account ID は 12 桁の数字"),
  teamName: teamNameSchema,
  accountGroupId: z.string().optional(),
  problemSetId: z.string().optional(),
});
export type DeployRequest = z.infer<typeof DeployRequestSchema>;

/**
 * [Composite Runtime / Issue #2075] Request body for a `runtime.kind=composite`
 * deploy. DERIVED from {@link DeployRequestSchema} so the two never drift — only
 * `awsAccountId` / `region` are relaxed to optional (a composite plan requires
 * them only when it has an AWS target; the deploy handler enforces that after
 * resolving the plan). Every other field — including the strict region / account
 * regexes when those fields ARE supplied — is inherited unchanged. It carries NO
 * provider credential / secret field; those never cross the HTTP boundary.
 */
export const CompositeDeployRequestSchema = DeployRequestSchema.partial({
  region: true,
  awsAccountId: true,
});
export type CompositeDeployRequest = z.infer<typeof CompositeDeployRequestSchema>;

/**
 * Deployments テーブルの行 (DocumentClient shape)。
 *
 *   PK     = `DEPLOYMENT#<jobId>` / SK = `META`
 *   GSI1PK = `TENANT#<tenantId>` / GSI1SK = `<createdAt>` (ISO8601、テナント別ソート用)
 *   GSI2PK = `TEAMKEY#<teamLoginKey>` / GSI2SK = `<createdAt>` (sparse、participant portal が引く)
 *
 * [Issue #2527 Slice 1 step 2] The domain fields live on
 * {@link DeploymentRecord} (`control-data/domain/deployments.ts`, the source of
 * truth); this item only adds the physical DynamoDB keys.
 */
export interface DeploymentItem extends DeploymentRecord {
  PK: string;
  SK: "META";
  GSI1PK: string;
  GSI1SK: string;
  /** sparse — `teamLoginKey` を無効化したい場合は属性ごと削除する。 */
  GSI2PK?: string;
  GSI2SK?: string;
}

export const DeployResponseSchema = z.object({
  jobId: z.string(),
  status: DeploymentStatusSchema,
  namePrefix: z.string(),
  teamLoginKey: z.string(),
  expiresAt: z.number(),
});
export type DeployResponse = z.infer<typeof DeployResponseSchema>;
