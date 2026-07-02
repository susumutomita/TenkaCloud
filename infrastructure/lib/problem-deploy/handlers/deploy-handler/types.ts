import { z } from "zod";
import type { DeploymentProvenance } from "../shared/deployment-provenance.js";

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
export type DeploymentStatus = z.infer<typeof DeploymentStatusSchema>;

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
 */
export interface DeploymentItem {
  PK: string;
  SK: "META";
  GSI1PK: string;
  GSI1SK: string;
  /** sparse — `teamLoginKey` を無効化したい場合は属性ごと削除する。 */
  GSI2PK?: string;
  GSI2SK?: string;

  jobId: string;
  problemId: string;
  tenantId: string;
  awsAccountId: string;
  /**
   * Cross-account deploy RoleArn resolved from CompetitorAccounts. Participant SSO uses it as
   * the first hop before assuming the per-problem ParticipantViewerRole.
   */
  competitorRoleArn?: string;
  /** SSM SecureString path that stores the tenant ExternalId for cross-account operations. */
  externalIdParameterName?: string;
  region: string;
  /**
   * 内部 slug。operator が deploy form で入力し、`namePrefix` (CFn StackName) の
   * 由来となる。CFn StackName は immutable なので、この値も deploy 後に変えない。
   * 競技者向け表示には `displayTeamName` を優先するため、portal UI には基本出さない。
   */
  teamName: string;
  namePrefix: string;
  /**
   * 競技者が portal `PATCH /portal/me` で設定する表示用チーム名。チームビルディング
   * 体験のため、operator 入力ではなく競技者自身が決める。未設定なら undefined。
   */
  displayTeamName?: string;
  /** 短命キー。API レスポンスで TenantAdmin に 1 度だけ露出し、以降は DDB 内に閉じる。 */
  teamLoginKey: string;
  status: DeploymentStatus;

  /**
   * [ADR-026/027/032 / #1410-1412] 非 AWS runtime の問題 (sakura/azure/gcp) を deploy したときの
   * provider / engine / entry。 teardown / status が CFn 経由か adapter 経由かの判別に使う。
   * **absent = aws/cloudformation** (legacy 行 / 既定。 = 従来どおり CFn 経路)。
   */
  runtimeProvider?: string;
  runtimeEngine?: string;
  runtimeEntry?: string;

  /** worker (CFn 起動側) が埋める */
  stackId?: string;
  /** Step Functions の CodeBuildStartBuild output (= `Build.Id`) から永続化する build ID。 */
  buildId?: string;
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

  /**
   * ADR-004 Phase 2: bulk deploy 経由で作られた deployment 行は、紐づく Event / Team を
   * 参照する。旧 `POST /problems/:id/deploy` 経路で作られた行は両方 undefined (後方互換)。
   */
  eventId?: string;
  teamId?: string;

  /**
   * [Problem Packs / Issue #2096] Pack provenance for a PACK-SOURCED deployment,
   * copied from the EVENT-pinned catalog snapshot (#2095) at deploy time — never
   * from client input. Absent for core (non-pack) deployments, so legacy / core
   * rows stay byte-identical. The detail API surfaces it only when present; the
   * list summary never does. It carries no local path / source credential.
   */
  provenance?: DeploymentProvenance;

  /**
   * 競技開始時刻 (ISO8601) を Event から denormalize したコピー。HealthCheckLambda が
   * probe / 採点 gate で参照する (now < eventStartsAt なら skip)。Bulk Deploy 時に
   * Event.startsAt をコピーし、operator が schedule API で更新したら全 deployment 行へ
   * 伝播する (event-handler/schedule.ts)。未設定 → 採点無し (= deploy 直後の誤加算防止)。
   */
  eventStartsAt?: string;
  /**
   * 競技終了時刻 (ISO8601) を Event から denormalize したコピー。HealthCheckLambda が
   * probe / 採点 gate で参照する (eventEndsAt <= now なら skip)。`POST /events/:id/end`
   * で operator が明示的に終了させたとき、event-handler が全 deployment 行へ伝播する。
   * 未設定 → 終了 gate 無し (= 旧 deployment / 終了未指示の event で既存挙動を保つ)。
   */
  eventEndsAt?: string;

  /** Scoring engine が加算したチームの累計ポイント。0 default。 */
  score?: number;
  /** 最後に scoring が走った時刻 (ISO 8601)。 */
  lastScoredAt?: string;
  /** Battle (uptime) で最後の health check が成功したか。 */
  lastResult?: "ok" | "fail";
  /** 最新の scoring probe が観測した participant-facing posture snapshot。 */
  posture?: string;
  /** 最新の scoring probe が分類した platform tier (例: posture-3 / production)。 */
  platform?: string;
  /**
   * Challenge (flag) で 1 度でも正解 submit されたら true。再提出での重複加算を防ぐ。
   */
  flagSubmitted?: boolean;
  /**
   * Issue #2283: この行が Progression Gate の Gate challenge で、 完了 bonus
   * (teamOverrides[].completionBonus) を加算済みなら加算時刻 (ISO 8601)。
   * `attribute_not_exists` ConditionExpression の冪等 guard として使い、 bonus の
   * 二重加算をレースから守る (= flagSubmitted と同じ one-time パターン)。
   */
  gateBonusAwardedAt?: string;
  /**
   * Issue #2283: Gate 完了を scoring tick が latch した時刻 (ISO 8601)。 完了後に uptime
   * penalty で score が 0 以下へ戻っても unlock 状態を維持するための one-time marker
   * (bonus の有無と独立に全 team の Gate 行へ書かれる)。
   */
  gateCompletedAt?: string;
  /**
   * Issue #1796: multi-flag kind で正解済みの sub-flag id の集合。 DynamoDB の String Set (SS)
   * として保持し、 lib-dynamodb が JS `Set<string>` ↔ SS を marshal する。 旧 row / 手書き行は
   * 持たない (= 「未解答」 と等価) ので、 単一 `flagSubmitted` boolean を集合へ拡張した形。
   * flag ごとに 1 回だけ ADD し、 `ConditionExpression` で 2 重加算を防ぐ。
   */
  solvedFlagIds?: ReadonlySet<string>;
  /**
   * Issue #817: Challenge (flag) で不正解 submit を受けた累計回数。 0 default。
   * `wrongAnswerPenalty > 0` の問題で 1 不正解ごとに ADD 1 + score 減算する経路で使う。
   */
  wrongAnswerCount?: number;
  /**
   * 直近の health check で endpoint ごとに probe した結果の JSON 文字列。
   * shape: `{ [outputKey]: { ok, checkedAt, since? } }`。
   * `since` は ok=false が続いている開始時刻 (= attack を検知した時刻)。
   * Battle 防御側が「どの endpoint が何分前から落ちている」を画面で見るため。
   */
  endpointsHealth?: string;
  /**
   * ADR-012 Phase 3.B: 5 種 builtin kind の中で polling 越しに per-deployment で保持する
   * scoring state の JSON 文字列。
   * - `attack-detection` の前回 counter (= 差分加算の baseline)
   * - `phased-polling` の bonus once 制御 flag map
   * shape: `{ attackCount?: number, bonusAwarded?: Record<string, true> }`。
   * dispatcher が UpdateItem で書き戻し、 次 tick で read-through に復元する。
   */
  scoringState?: string;
  /**
   * Issue #742 Phase 2: 競技者が reveal した progressive hint の記録。 reveal は idempotent
   * (= 同 hintId 重複は no-op、 penalty は 1 度だけ適用)。
   *
   * shape: `[{ hintId, revealedAt: ISO8601, penaltyApplied }]`
   *
   * DDB は schemaless なので table 側の structural 変更は不要 (= attribute を新規追加するだけ)。
   * 旧 row は本 attribute を持たない → 「未 reveal」 と等価。 Phase 3 (= reveal API) で
   * UpdateItem で append、 Phase 4 (= frontend UI) で UI に locked / unlocked 状態を反映。
   *
   * 本 Phase 2 では type addition + helper (= hintRevealRecord 構造) のみ。 read/write 経路は
   * Phase 3 で追加する。
   */
  hintsRevealed?: readonly HintRevealRecord[];
}

/**
 * Issue #742 Phase 2: progressive hint reveal 1 件の記録。 Deployments table の
 * `hintsRevealed` attribute に append する。
 *
 *   - hintId: metadata.scoring.hints[].id を参照 (= ProgressiveHint.id と一致)
 *   - revealedAt: ISO 8601 string (= 監査 log + UI 表示用)
 *   - penaltyApplied: 実 deduction された penalty (= metadata 編集後にも記録が drift しないため
 *     当時値を保存。 metadata.scoring.hints[].penalty 変更時にも score 再計算は走らない)
 */
export interface HintRevealRecord {
  readonly hintId: string;
  readonly revealedAt: string;
  readonly penaltyApplied: number;
}

export const DeployResponseSchema = z.object({
  jobId: z.string(),
  status: DeploymentStatusSchema,
  namePrefix: z.string(),
  teamLoginKey: z.string(),
  expiresAt: z.number(),
});
export type DeployResponse = z.infer<typeof DeployResponseSchema>;
