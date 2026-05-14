import { z } from "zod";

export {
  type DeployCreateRequestedDetail,
  DeployCreateRequestedDetailSchema,
  EVENT_DETAIL_TYPE_DEPLOY_CREATE_REQUESTED,
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
  /**
   * Challenge (flag) で 1 度でも正解 submit されたら true。再提出での重複加算を防ぐ。
   */
  flagSubmitted?: boolean;
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
}

export const DeployResponseSchema = z.object({
  jobId: z.string(),
  status: DeploymentStatusSchema,
  namePrefix: z.string(),
  teamLoginKey: z.string(),
  expiresAt: z.number(),
});
export type DeployResponse = z.infer<typeof DeployResponseSchema>;
