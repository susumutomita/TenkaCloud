import type { ApiClient } from "./client-contract";

export const EVENT_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export type EventStatus = "DRAFT" | "DEPLOYING" | "READY" | "ENDED" | "TEARDOWN" | "ARCHIVED";

export interface EventProblemTarget {
  problemId: string;
  /** @deprecated #528: AWS Account は team 単位 (= TeamSummary.awsAccountId) に移行。
   *  旧 Event の fallback としてのみ残す。Phase 2 で削除予定。 */
  defaultAwsAccountId?: string;
  defaultRegion: string;
}

export interface EventSummary {
  eventId: string;
  name: string;
  status: EventStatus;
  teamCount: number;
  problemCount: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
  /** 競技開始時刻 (ISO8601, UTC)。未設定なら HealthCheck は採点しない (= deploy 直後の誤加算防止)。 */
  startsAt?: string;
  /** 競技終了時刻 (ISO8601, UTC、#536)。HealthCheck は `now >= endsAt` で採点 gate 閉。
   *  「Event を終了」 button (= 即時終了) と「日時を指定して終了」 (= 予約) の両方が書き込む。 */
  endsAt?: string;
  /** 自動撤去予定時刻 (ISO8601, UTC)。reconciler が `now >= teardownAt` で bulk teardown を自動発火。 */
  teardownAt?: string;
  /** 自動デプロイ予定時刻 (ISO8601, UTC)。reconciler が `now >= deployAt` で DRAFT event を bulk deploy。 */
  deployAt?: string;
  /** #558: 採点 lock flag。true なら加点経路全停止 (= 表彰フェーズ)、leaderboard read は許可。 */
  scoringLocked?: boolean;
  /** #558: scoringLocked=true にした時刻 (ISO 8601, UTC)。 */
  scoringLockedAt?: string;
  /**
   * Issue #1038 P1 #9 follow-up: scoreboard freeze window 分数。 0=freeze 無効、 1〜180=N 分前から
   * 順位非公開、 未設定=default 30 分。 PATCH /events/:eventId/schedule で更新可能。
   */
  scoreboardFreezeMinutes?: number;
}

export interface EventListResponse {
  items: readonly EventSummary[];
  nextCursor?: string;
}

export interface TeamSummary {
  teamId: string;
  internalSlug: string;
  displayName?: string;
  /** #528: team の deploy 先 AWS Account ID (12 桁)。旧 Event は undefined。 */
  awsAccountId?: string;
  /** Admin/Operator の明示的な detail expansion でのみ返る。 */
  teamLoginKey?: string;
}

export type EventDeploymentStatus =
  | "PENDING"
  | "IN_PROGRESS"
  | "COMPLETE"
  | "FAILED"
  | "DELETING"
  | "DELETED"
  | "EXPIRED"
  | "AUTO_DELETED";

export interface EventDeploymentSummary {
  jobId: string;
  teamId: string;
  status: EventDeploymentStatus;
}

/**
 * Issue #1038 P1 #7: operator 側 Event 詳細画面で全 team の score event 推移を可視化する。
 * `?withScoreEvents=true` を付けた `getEvent` でのみ含まれる (default は undefined)。
 */
export interface TeamScoreEventView {
  jobId: string;
  problemId: string;
  /** Issue #2283: "gate-bonus" = Progression Gate 完了時に 1 度だけ付与される固定ボーナス。 */
  source: "uptime" | "flag" | "flag-wrong" | "hint" | "gate-bonus";
  points: number;
  result: "ok" | "wrong";
  occurredAt: string;
}

export interface TeamScoreEvents {
  teamId: string;
  teamName: string;
  /** occurredAt 昇順 (= chart の cumulative 計算に向く)。 */
  events: readonly TeamScoreEventView[];
}

/** Issue #2283: Progression Gate の team 単位 policy。 "required" = Gate 完了まで unlock target を lock / "off" = bypass。 */
export type ProgressionGatePolicy = "required" | "off";

/** Issue #2283: team 単位の上書き。 `completionBonus` は Gate 完了時に 1 度だけ付与 (int 0..100000、省略時 0)。 */
export interface ProgressionGateTeamOverride {
  policy: ProgressionGatePolicy;
  completionBonus?: number;
}

/**
 * Issue #2283: Event 1 件の Progression Gate 設定 (= `PUT /events/:eventId/progression-gate` body)。
 * wire shape の source of truth は
 * infrastructure/lib/problem-deploy/handlers/shared/progression-gate.ts の
 * `ProgressionGateConfigSchema` (自己参照 / 重複 target は backend が reject する)。
 */
export interface ProgressionGateConfig {
  /** Gate になる challenge の problemId (Event の問題セットに含まれること)。 */
  gateProblemId: string;
  /** Gate 完了までロックする problemId (1..49、重複なし、gateProblemId を含まない)。 */
  unlockTargetIds: readonly string[];
  defaultPolicy: ProgressionGatePolicy;
  /** key = その Event の teamId。 未記載 team は defaultPolicy に従う。 */
  teamOverrides?: Readonly<Record<string, ProgressionGateTeamOverride>>;
}

export interface EventDetail extends EventSummary {
  teams: readonly TeamSummary[];
  problems: readonly EventProblemTarget[];
  /**
   * `problemId` ごとの deploy job 一覧 (= 全 team 分)。Bulk Deploy 前は空 record。
   * 旧 jobId-based deployment は eventId が無いので含まれない。
   */
  deploymentsByProblem: Readonly<Record<string, readonly EventDeploymentSummary[]>>;
  /** Issue #1038 P1 #7: opt-in で全 team の累計 score event timeline を含む。 */
  scoreEventsByTeam?: readonly TeamScoreEvents[];
  /** Issue #2283: Progression Gate 設定。未設定 (= Gate 無し) は undefined。 */
  progressionGate?: ProgressionGateConfig;
}

export interface CreateEventTeamInput {
  internalSlug: string;
  /** #528: AWS event deploy target (12 digits); required only for AWS-only events. */
  awsAccountId?: string;
  /** #2563: provider credential teamSlug for non-AWS single-provider events. */
  nonAwsCredentialTeamSlug?: string;
}

export interface CreateEventRequest {
  name: string;
  teams: readonly CreateEventTeamInput[];
  problems: readonly EventProblemTarget[];
}

export interface CreateEventResponse {
  eventId: string;
  status: EventStatus;
  createdAt: string;
  expiresAt: number;
  teams: readonly {
    teamId: string;
    internalSlug: string;
    teamLoginKey: string;
  }[];
  problems: readonly EventProblemTarget[];
}

export interface BulkResult {
  eventId: string;
  enqueued: number;
  skipped: number;
}

export async function listEvents(
  api: ApiClient,
  options: { limit?: number; cursor?: string } = {},
): Promise<EventListResponse> {
  const params = new URLSearchParams();
  if (options.limit) params.set("limit", String(options.limit));
  if (options.cursor) params.set("cursor", options.cursor);
  const qs = params.toString();
  return api.get<EventListResponse>(qs ? `events?${qs}` : "events");
}

export async function getEvent(
  api: ApiClient,
  eventId: string,
  options: {
    readonly withScoreEvents?: boolean;
    readonly withTeamLoginKeys?: boolean;
  } = {},
): Promise<EventDetail> {
  const params = new URLSearchParams();
  if (options.withScoreEvents) params.set("withScoreEvents", "true");
  if (options.withTeamLoginKeys) params.set("withTeamLoginKeys", "true");
  const query = params.toString();
  const path = `events/${encodeURIComponent(eventId)}${query ? `?${query}` : ""}`;
  return api.get<EventDetail>(path);
}

export async function createEvent(
  api: ApiClient,
  body: CreateEventRequest,
): Promise<CreateEventResponse> {
  return api.post<CreateEventResponse>("events", body);
}

export interface RotateTeamLoginKeyResponse {
  readonly kind: "ok";
  readonly teamId: string;
  readonly teamLoginKey: string;
  readonly rotatedAt: string;
}

/** Rotate one team bearer and return the replacement plaintext immediately. */
export function rotateTeamLoginKey(
  api: ApiClient,
  eventId: string,
  teamId: string,
): Promise<RotateTeamLoginKeyResponse> {
  return api.post<RotateTeamLoginKeyResponse>(
    `events/${encodeURIComponent(eventId)}/teams/${encodeURIComponent(teamId)}/rotate-login-key`,
    {},
  );
}

/**
 * #555: `POST /events/:id/deploy` の opt-in body。全フィールド optional:
 *   - `retryFailedOnly: true` — FAILED 状態の deployment 行だけ再実行 (= 失敗分 retry)
 *   - `forceRedeploy: true` — COMPLETE/FAILED/DELETED の既存 deployment を置換して再実行
 *   - `teamIds` — 指定 team のみ deploy (= 後追い team / 該当 team の env 再構築)
 *   - `problemIds` — 指定 problem のみ deploy (= 後追い問題 / 修正済問題の全 team 再 deploy)
 *
 * 何も指定しないと従来通り teams × problems を全展開 (= idempotent skip で衝突は飛ばす)。
 */
export interface BulkDeployBody {
  retryFailedOnly?: true;
  forceRedeploy?: true;
  teamIds?: readonly string[];
  problemIds?: readonly string[];
}
export async function bulkDeployEvent(
  api: ApiClient,
  eventId: string,
  body: BulkDeployBody = {},
): Promise<BulkResult> {
  return api.post<BulkResult>(`events/${encodeURIComponent(eventId)}/deploy`, body);
}

export async function bulkTeardownEvent(api: ApiClient, eventId: string): Promise<BulkResult> {
  return api.delJson<BulkResult>(`events/${encodeURIComponent(eventId)}`);
}

export interface SetScheduleResult {
  /** #536: backend は指定された field のみ返す。startsAt 未指定なら undefined */
  startsAt?: string;
  /** #536: endsAt も同様 */
  endsAt?: string;
  /** teardownAt も指定された場合のみ返る */
  teardownAt?: string;
  /** deployAt も指定された場合のみ返る */
  deployAt?: string;
  updatedDeployments: number;
}

/**
 * 競技開始/終了時刻を設定する。`{ startsAt }` で日時指定、`{ startNow: true }` で server now 採用。
 * #536: `{ endsAt }` も同 endpoint で受ける (= 終了予約)。組み合わせ可:
 *   `{ startsAt }` / `{ startNow: true }` / `{ endsAt }` / `{ startsAt, endsAt }` /
 *   `{ startNow: true, endsAt }`
 * Event + 紐づく全 deployment 行に伝播する (eventStartsAt / eventEndsAt の denormalize)。
 */
export interface SetEventScheduleBody {
  startsAt?: string;
  startNow?: true;
  endsAt?: string;
  /** 自動撤去予定時刻 (ISO8601)。teardownAt >= endsAt 必須 (backend が検証)。 */
  teardownAt?: string;
  /** 自動デプロイ予定時刻 (ISO8601)。deployAt <= endsAt 必須 (backend が検証)。 */
  deployAt?: string;
  /** Issue #1038 P1 #9 follow-up: 0=freeze 無効 / 1〜180=N 分前から freeze */
  scoreboardFreezeMinutes?: number;
}
export async function setEventSchedule(
  api: ApiClient,
  eventId: string,
  body: SetEventScheduleBody,
): Promise<SetScheduleResult> {
  return api.patch<SetScheduleResult>(`events/${encodeURIComponent(eventId)}/schedule`, body);
}

export interface EndEventResult {
  endsAt: string;
  updatedDeployments: number;
}

/**
 * Event を ENDED 状態に遷移させ、紐づく全 deployment 行に \`eventEndsAt\` を伝播する。
 * READY 状態の event のみ受理 (= 二重操作 / 未開始 event の終了は 409)。
 */
export async function endEvent(api: ApiClient, eventId: string): Promise<EndEventResult> {
  return api.post<EndEventResult>(`events/${encodeURIComponent(eventId)}/end`, {});
}

export interface ArchiveEventResult {
  archivedAt: string;
}

export interface LockScoringResult {
  scoringLocked: boolean;
  scoringLockedAt?: string;
  /** idempotent: 既に target 状態だった (= no-op で 200) のときに true。 */
  idempotent?: boolean;
}

/**
 * #558: Event の採点を lock (= 表彰フェーズ、加点経路全停止)。
 * READY / ENDED のみ受理 (= 409 not_lockable for other statuses)。idempotent: 既に
 * locked のときも 200 + `idempotent: true` で返す。
 */
export async function lockEventScoring(
  api: ApiClient,
  eventId: string,
): Promise<LockScoringResult> {
  return api.post<LockScoringResult>(`events/${encodeURIComponent(eventId)}/lock-scoring`, {});
}

/**
 * #558: Event の採点 lock を解除 (= reversible)。同じく READY / ENDED のみ受理。
 */
export async function unlockEventScoring(
  api: ApiClient,
  eventId: string,
): Promise<LockScoringResult> {
  return api.delJson<LockScoringResult>(`events/${encodeURIComponent(eventId)}/lock-scoring`);
}

/**
 * Event を ARCHIVED 状態にして EventList のデフォルト view から外す soft delete (Issue #493)。
 * 許可: DRAFT (一度も deploy していない) / ENDED (採点停止済) / TEARDOWN (一括削除済)。
 * 拒否: DEPLOYING / READY / ARCHIVED は 409 で拒否される。
 */
export async function archiveEvent(api: ApiClient, eventId: string): Promise<ArchiveEventResult> {
  return api.post<ArchiveEventResult>(`events/${encodeURIComponent(eventId)}/archive`, {});
}

/**
 * Notifications API: 運営 → 競技者 通知を 1 件発信する。tenant 不一致 / event 不在は 404。
 * `severity` 既定 `info`。`title` 1〜120、`body` 1〜2000 chars。
 */
export interface CreateNotificationRequest {
  title: string;
  body: string;
  severity?: "info" | "warning";
}

export interface CreateNotificationResponse {
  notificationId: string;
  occurredAt: string;
}

export async function createNotification(
  api: ApiClient,
  eventId: string,
  body: CreateNotificationRequest,
): Promise<CreateNotificationResponse> {
  return api.post<CreateNotificationResponse>(
    `events/${encodeURIComponent(eventId)}/notifications`,
    body,
  );
}

export interface PutProgressionGateResult {
  progressionGate: ProgressionGateConfig;
}

/**
 * Issue #2283: Progression Gate 設定を保存する (full-replace)。
 * tenant runtime flag `challengePrerequisiteGate` OFF は 409 `{ error: "feature_disabled" }`、
 * cross-entity 検証失敗は 400 `{ error: "invalid_progression_gate", reason }` が返る。
 */
export async function putEventProgressionGate(
  api: ApiClient,
  eventId: string,
  config: ProgressionGateConfig,
): Promise<PutProgressionGateResult> {
  return api.put<PutProgressionGateResult>(
    `events/${encodeURIComponent(eventId)}/progression-gate`,
    config,
  );
}

export interface RemoveProgressionGateResult {
  /** idempotent: 既に未設定だった場合は false (= no-op でも 200)。 */
  removed: boolean;
}

/** Issue #2283: Progression Gate 設定を除去する (idempotent。flag OFF でも掃除経路として許可)。 */
export async function deleteEventProgressionGate(
  api: ApiClient,
  eventId: string,
): Promise<RemoveProgressionGateResult> {
  return api.delJson<RemoveProgressionGateResult>(
    `events/${encodeURIComponent(eventId)}/progression-gate`,
  );
}

interface TenantFeatureFlagsResponse {
  flags: Record<string, boolean>;
}

/**
 * Issue #2283: per-tenant runtime feature flag overrides を取得する (全 tenant role 可)。
 * backend の Gate 判定は tenant DDB 行のみを見るため、 Gate UI の有効判定も
 * `config.features` (build/runtime-config 由来) ではなく本経路を使う (= backend と判定源を一致)。
 */
export async function getTenantFeatureFlags(api: ApiClient): Promise<Record<string, boolean>> {
  const res = await api.get<TenantFeatureFlagsResponse>("feature-flags");
  return res.flags;
}

/** Per-tenant feature flag overrides を full-replace する (TenantAdmin のみ、他 role は 403)。 */
export async function putTenantFeatureFlags(
  api: ApiClient,
  flags: Readonly<Record<string, boolean>>,
): Promise<Record<string, boolean>> {
  const res = await api.put<TenantFeatureFlagsResponse>("admin/feature-flags", flags);
  return res.flags;
}
