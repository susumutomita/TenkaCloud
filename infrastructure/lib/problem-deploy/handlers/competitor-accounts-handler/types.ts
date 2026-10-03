import { z } from "zod";
import type { CompetitorAccountRecord } from "../../control-data/domain/competitor-accounts.js";

/**
 * `CompetitorAccounts` DDB 1 行の shape (Issue #459)。
 *
 *   PK = `TENANT#<tenantId>`  /  SK = `ACCOUNT#<awsAccountId>`
 *
 * ExternalId は本テーブルに **保存しない**。同じ tenant の SSM SecureString から都度取得する。
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

/**
 * Issue: AWS Organizations 規模の一括登録 (`POST /admin/competitor-accounts/bulk`)。
 *
 * 1 行ごとの `competitorRoleName` / `region` は `defaults` で代表させられる。 StackSet で
 * OU 全体へ bootstrap を配ると 3 パラメータは全アカウント共通になるので、 実運用の JSON は
 * `awsAccountId` (+ 任意の `alias`) の列と `defaults` 1 つになる。
 *
 * `competitorRoleName` に zod default を置かないのは単体 create と同じ理由で、 **caller が
 * tenantId を落としたときに暗黙の名前衝突を起こさない**ため。 row にも `defaults` にも無い
 * 行は `invalid` として個別に弾き、 他の行は通す。
 */
const BulkCompetitorAccountEntrySchema = z
  .object({
    awsAccountId: z.string().regex(AWS_ACCOUNT_ID_RE, "AWS Account ID は 12 桁の数字"),
    region: z.string().regex(AWS_REGION_RE, "AWS region 形式が不正です").optional(),
    competitorRoleName: z
      .string()
      .regex(IAM_ROLE_NAME_RE, "IAM Role 名の形式が不正です")
      .optional(),
    alias: z.string().min(1).max(120).optional(),
  })
  .strict();
export type BulkCompetitorAccountEntry = z.infer<typeof BulkCompetitorAccountEntrySchema>;

/**
 * 1 request の上限。 Lambda の実行時間と payload を有界にするためのもので、 超えたら
 * 400 で全体を拒否する (= 途中まで書いて切れるより、 operator が分割する方が読める)。
 *
 * 値は handler Lambda の timeout (60s) から逆算している。 行は逐次に書かれ、 turso backend
 * では 1 write = remote HTTP 1 往復なので、 悲観値 500ms/行 でも 50 行で 25s に収まる。
 * 上限を上げるときは `competitor-accounts-api-lambda.ts` の timeout も一緒に見直すこと
 * (timeout に届くと、 書けた行は残るのに応答が返らない = どこまで入ったか分からなくなる)。
 */
export const BULK_COMPETITOR_ACCOUNTS_MAX_ENTRIES = 50;

export const BulkCreateCompetitorAccountsRequestSchema = z
  .object({
    defaults: z
      .object({
        region: z.string().regex(AWS_REGION_RE, "AWS region 形式が不正です").optional(),
        competitorRoleName: z
          .string()
          .regex(IAM_ROLE_NAME_RE, "IAM Role 名の形式が不正です")
          .optional(),
      })
      .strict()
      .optional(),
    accounts: z
      .array(BulkCompetitorAccountEntrySchema)
      .min(1, "accounts が空です")
      .max(
        BULK_COMPETITOR_ACCOUNTS_MAX_ENTRIES,
        `accounts は 1 request あたり ${BULK_COMPETITOR_ACCOUNTS_MAX_ENTRIES} 件までです`,
      ),
  })
  .strict();
export type BulkCreateCompetitorAccountsRequest = z.infer<
  typeof BulkCreateCompetitorAccountsRequestSchema
>;

/** 1 行の結果。 `created` 以外は他の行の成否に影響しない。 */
export type BulkCompetitorAccountOutcome = "created" | "duplicate" | "invalid" | "failed";

export interface BulkCompetitorAccountResult {
  readonly awsAccountId: string;
  readonly outcome: BulkCompetitorAccountOutcome;
  /** `created` 以外のときだけ、 その行が通らなかった理由 (operator 向け、秘密を含まない)。 */
  readonly message?: string;
}

export interface BulkCreateCompetitorAccountsResponse {
  readonly results: readonly BulkCompetitorAccountResult[];
  readonly created: number;
  readonly duplicate: number;
  readonly invalid: number;
  readonly failed: number;
  /**
   * 競技者へ渡す tenant の ExternalId。 **1 件でも作成できたときだけ**載せる
   * (= 全行が duplicate なら新しく配る bootstrap は無いので、 secret を露出しない)。
   */
  readonly externalId?: string;
  readonly tenkaCloudAccountId: string;
}

export interface CompetitorAccountSummary {
  awsAccountId: string;
  region: string;
  competitorRoleName: string;
  alias?: string;
  verified: boolean;
  verifiedAt?: string;
  createdAt: string;
  updatedAt: string;
  /** 最後に ExternalId を rotate した時刻 (Issue #596)。未 rotate なら undefined。 */
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
