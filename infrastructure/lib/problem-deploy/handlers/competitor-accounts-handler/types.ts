import { z } from "zod";
import type { CompetitorAccountRecord } from "../../control-data/domain/competitor-accounts.js";

/**
 * `CompetitorAccounts` DDB 1 行の shape (Issue #459 / ADR-002 Decision 2.1)。
 *
 *   PK = `TENANT#<tenantId>`  /  SK = `ACCOUNT#<awsAccountId>`
 *
 * ExternalId は本テーブルに **保存しない** — 同じ tenant の SSM SecureString 経由 (= ADR-002 §2.2)。
 *
 * [Issue #2527 Slice 1 step 2] The domain fields live on
 * {@link CompetitorAccountRecord} (`control-data/domain/competitor-accounts.ts`,
 * the source of truth); this item only adds the physical DynamoDB keys.
 */
export interface CompetitorAccountItem extends CompetitorAccountRecord {
  PK: string;
  SK: string;
}

const AWS_ACCOUNT_ID_RE = /^\d{12}$/;
const AWS_REGION_RE = /^[a-z]{2}-[a-z]+-\d+$/;
// IAM Role 名の許容 charclass (CFn `competitor-bootstrap.yaml` の `AllowedPattern` と同じ)。
const IAM_ROLE_NAME_RE = /^[A-Za-z0-9_+=,.@-]{1,64}$/;

export const CreateCompetitorAccountRequestSchema = z
  .object({
    awsAccountId: z.string().regex(AWS_ACCOUNT_ID_RE, "AWS Account ID は 12 桁の数字"),
    /**
     * deploy 先 region (= `competitor-bootstrap.yaml` を deploy した region と一致)。
     * default は `ap-northeast-1` (Tokyo)。
     */
    region: z.string().regex(AWS_REGION_RE, "AWS region 形式が不正です").default("ap-northeast-1"),
    /**
     * 競技者側 bootstrap が作る IAM Role 名。 Issue #1314 以降、 frontend は
     * `defaultCompetitorRoleName({ tenantId })` で Plane scope の unique 名 (例
     * `TenkaCloud-acme-deploy-Role`) を提案する。 operator はそれを編集できるが、
     * 固定 default を schema 側で持つと **caller の tenantId が抜けたとき暗黙に
     * 名前衝突する** ため zod default は外す (= 呼び側で必ず明示)。
     */
    competitorRoleName: z.string().regex(IAM_ROLE_NAME_RE, "IAM Role 名の形式が不正です"),
    /** operator 表示用ラベル (例: `Team Acme prod`)。任意。 */
    alias: z.string().min(1).max(120).optional(),
  })
  .strict();
export type CreateCompetitorAccountRequest = z.infer<typeof CreateCompetitorAccountRequestSchema>;

export interface CompetitorAccountSummary {
  awsAccountId: string;
  region: string;
  competitorRoleName: string;
  alias?: string;
  verified: boolean;
  verifiedAt?: string;
  createdAt: string;
  updatedAt: string;
  /** 最後に ExternalId を rotate した時刻 (Issue #596 / ADR-002 Phase 3.1)。未 rotate なら undefined。 */
  rotatedAt?: string;
}

export interface CreateCompetitorAccountResponse extends CompetitorAccountSummary {
  /**
   * 競技者に **1 度だけ** 露出する secret。`competitor-bootstrap.yaml` の Parameter として渡す。
   * 一覧 (`GET`) には含めない (= SSM SecureString から再取得が必要)。
   */
  externalId: string;
  /** 競技者に伝える TenkaCloud 側の AWS Account ID (CFn template の Parameter として要る)。 */
  tenkaCloudAccountId: string;
}
