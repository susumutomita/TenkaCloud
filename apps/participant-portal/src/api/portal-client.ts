export type DeploymentStatus =
  | "PENDING"
  | "IN_PROGRESS"
  | "COMPLETE"
  | "FAILED"
  | "DELETING"
  | "DELETED";

export const TERMINAL_STATUSES: ReadonlySet<DeploymentStatus> = new Set([
  "COMPLETE",
  "FAILED",
  "DELETED",
]);

export interface ParticipantScoringInfo {
  readonly kind: "flag" | "uptime";
  readonly points?: number;
  readonly pointsPerSuccess?: number;
  readonly hints?: readonly string[];
  readonly flagSubmitted?: boolean;
}

/**
 * Battle (uptime kind) の集約 health (ADR-005 D1)。per-endpoint URL / 名前は **絶対に
 * 露出しない** (= ゲーム性のため)。Challenge (flag kind) では undefined。
 */
export type ApplicationStatusOverall = "healthy" | "degraded" | "down" | "unknown";

export interface ApplicationStatus {
  readonly overall: ApplicationStatusOverall;
  readonly healthyCount: number;
  readonly totalCount: number;
  readonly checkedAt?: string;
}

/**
 * Phase 2c: 1 problem 単位の view (= team の N 問題のうち 1 つ)。
 */
export interface ParticipantProblemView {
  readonly jobId: string;
  readonly problemId: string;
  readonly region: string;
  /** 競技アカウント ID。SSO Credentials の AWS Console federation で使う。 */
  readonly awsAccountId: string;
  readonly status: DeploymentStatus;
  readonly stackOutputs: Record<string, string>;
  readonly failureReason?: string;
  readonly expiresAt: number;
  readonly score: number;
  readonly lastScoredAt?: string;
  readonly lastResult?: "ok" | "fail";
  readonly scoring?: ParticipantScoringInfo;
  /** ADR-005 Phase 3.1: Battle (uptime) のみ aggregate health を露出。 */
  readonly applicationStatus?: ApplicationStatus;
}

/**
 * Phase 2c: team の集約 view。1 teamLoginKey で event 内の N 問題を引ける。
 *
 * 設計判断: per-endpoint health (どの endpoint が落ちているか) は participant API には
 * 出さない。Battle のゲーム性 = 「なぜ壊れているかを防御側自身が調査して回復する」。
 */
export interface ParticipantTeamView {
  readonly team: {
    readonly teamName: string;
    readonly teamNameSetByCompetitor: boolean;
    readonly eventId?: string;
    readonly teamId?: string;
  };
  readonly problems: readonly ParticipantProblemView[];
}

export type SubmitFlagOutcome =
  | { kind: "ok"; scoreDelta: number; totalScore: number }
  | { kind: "already_scored"; totalScore: number }
  | { kind: "wrong" };

export class PortalValidationError extends Error {
  constructor(public readonly errorCode: string) {
    super("入力値が不正です。");
    this.name = "PortalValidationError";
  }
}

export class PortalAuthError extends Error {
  constructor() {
    super("チームログインキーが無効か、デプロイが既に削除されています。");
    this.name = "PortalAuthError";
  }
}

export class PortalNetworkError extends Error {
  constructor(
    public readonly status: number,
    body: string,
  ) {
    super(`Portal API ${status}: ${body || "unknown"}`);
    this.name = "PortalNetworkError";
  }
}

function buildPortalUrl(apiBaseUrl: string, path: string): URL {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  return new URL(path, base);
}

interface PortalFetchOptions {
  readonly method?: "GET" | "POST" | "PATCH";
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  /** 400 を `PortalValidationError(error)` に変換する (応答 body の `error` フィールドを採用)。 */
  readonly throwOn400?: boolean;
  /** 404 を `undefined` として返す (= "存在しない" を許容するエンドポイント)。 */
  readonly returnUndefinedOn404?: boolean;
}

/**
 * Portal API 共通 fetch。401→PortalAuthError / !ok→PortalNetworkError は全 endpoint
 * 共通なので 1 箇所に集約。400 (validation) と 404 (no-content) は opt-in。
 */
async function portalFetch<T>(
  apiBaseUrl: string,
  path: string,
  teamLoginKey: string,
  options: PortalFetchOptions = {},
): Promise<T | undefined> {
  const url = buildPortalUrl(apiBaseUrl, path);
  if (options.query) {
    for (const [k, v] of Object.entries(options.query)) url.searchParams.set(k, v);
  }
  const headers: Record<string, string> = { authorization: `Bearer ${teamLoginKey}` };
  const hasBody = options.body !== undefined;
  if (hasBody) headers["content-type"] = "application/json";

  const res = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    body: hasBody ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });
  if (res.status === 401) throw new PortalAuthError();
  if (res.status === 404 && options.returnUndefinedOn404) return undefined;
  if (res.status === 400 && options.throwOn400) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new PortalValidationError(body.error ?? "invalid_request");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new PortalNetworkError(res.status, body);
  }
  return (await res.json()) as T;
}

/**
 * `GET /portal/me` を `Authorization: Bearer <teamLoginKey>` で呼び、
 * `ParticipantTeamView` (= team + problems[]) を返す。
 */
export async function getPortalMe(
  apiBaseUrl: string,
  teamLoginKey: string,
  signal?: AbortSignal,
): Promise<ParticipantTeamView> {
  return (await portalFetch<ParticipantTeamView>(apiBaseUrl, "portal/me", teamLoginKey, {
    signal,
  })) as ParticipantTeamView;
}

/**
 * 競技者の表示用チーム名を team scope で更新する (`PATCH /portal/me { teamName }`)。
 * 全 deployment 行に伝播する (Lambda 側で並列 Update)。
 */
export async function updateTeamName(
  apiBaseUrl: string,
  teamLoginKey: string,
  teamName: string,
  signal?: AbortSignal,
): Promise<ParticipantTeamView> {
  return (await portalFetch<ParticipantTeamView>(apiBaseUrl, "portal/me", teamLoginKey, {
    method: "PATCH",
    body: { teamName },
    throwOn400: true,
    signal,
  })) as ParticipantTeamView;
}

/**
 * Phase 3: 自チームの加点履歴 (時系列降順)。flag 提出と uptime probe 成功の両方を含む。
 */
export interface ScoreEventView {
  readonly jobId: string;
  readonly problemId: string;
  readonly source: "uptime" | "flag";
  readonly points: number;
  readonly result: "ok";
  readonly occurredAt: string;
}

export interface ScoreEventsResponse {
  readonly entries: readonly ScoreEventView[];
}

/**
 * `GET /portal/me/score-events` を `Authorization: Bearer <teamLoginKey>` で呼ぶ。
 * occurredAt 降順で 100 件まで。team の全 deployment 横断で merge 済。
 */
export async function getScoreEvents(
  apiBaseUrl: string,
  teamLoginKey: string,
  signal?: AbortSignal,
): Promise<ScoreEventsResponse> {
  return (await portalFetch<ScoreEventsResponse>(
    apiBaseUrl,
    "portal/me/score-events",
    teamLoginKey,
    { signal },
  )) as ScoreEventsResponse;
}

/**
 * Phase 3: Event scope の team ランキング (= Scoreboard)。
 * 同じ event 内の全 team を score 降順 + 同点は teamName 昇順で並べた配列を返す。
 */
export interface LeaderboardEntry {
  readonly rank: number;
  readonly teamId: string;
  readonly teamName: string;
  readonly score: number;
  readonly completedProblems: number;
  readonly totalProblems: number;
  /** requester 自身のチームなら true (UI ハイライト用)。 */
  readonly isMyTeam: boolean;
}

export interface LeaderboardResponse {
  readonly eventId: string;
  readonly entries: readonly LeaderboardEntry[];
}

/**
 * `GET /portal/leaderboard` を `Authorization: Bearer <teamLoginKey>` で呼ぶ。
 * 旧 jobId-based deployment で eventId が無い場合は 404 → undefined を返す。
 */
export async function getLeaderboard(
  apiBaseUrl: string,
  teamLoginKey: string,
  signal?: AbortSignal,
): Promise<LeaderboardResponse | undefined> {
  return await portalFetch<LeaderboardResponse>(apiBaseUrl, "portal/leaderboard", teamLoginKey, {
    returnUndefinedOn404: true,
    signal,
  });
}

/**
 * SSO Credentials: AWS Console ワンクリック login URL を発行する API。
 * 競技者が click すると Lambda が STS AssumeRole + federation で SigninToken を
 * 発行し、URL を返す。frontend は window.open でその URL を開く (= 自前 AWS ログイン不要)。
 */
export async function getConsoleSigninUrl(
  apiBaseUrl: string,
  teamLoginKey: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<string> {
  const data = (await portalFetch<{ loginUrl: string }>(
    apiBaseUrl,
    "portal/me/console-signin-url",
    teamLoginKey,
    { query: { jobId }, throwOn400: true, signal },
  )) as { loginUrl: string };
  return data.loginUrl;
}

/**
 * ADR-005 Phase 3.1: 自 team の指定 deployment における attack-detected event の
 * 時系列。Battle Portal の Attack Statistics / Attack History タブが poll する。
 */
export interface BattleAttackEventView {
  readonly occurredAt: string;
  readonly source: "attack-detected";
  readonly result: "down";
  readonly recoveredAt: string | null;
}

export interface BattleAttacksResponse {
  readonly jobId: string;
  readonly problemId: string;
  readonly sinceMin: number;
  readonly events: readonly BattleAttackEventView[];
}

/**
 * `GET /portal/me/battle-attacks?jobId=&sinceMin=` を `Authorization: Bearer <teamLoginKey>`
 * で呼ぶ。直近 sinceMin (default 30、上限 60) 分内の attack-detected event を時系列降順
 * で返す。invalid_jobid / invalid_sincemin / not_found は `PortalValidationError` で throw。
 */
export async function getBattleAttacks(
  apiBaseUrl: string,
  teamLoginKey: string,
  jobId: string,
  sinceMin?: number,
  signal?: AbortSignal,
): Promise<BattleAttacksResponse> {
  const query: Record<string, string> = { jobId };
  if (sinceMin !== undefined) query.sinceMin = String(sinceMin);
  return (await portalFetch<BattleAttacksResponse>(
    apiBaseUrl,
    "portal/me/battle-attacks",
    teamLoginKey,
    { query, throwOn400: true, signal },
  )) as BattleAttacksResponse;
}

/**
 * ADR-006 Notifications: 運営 → 競技者 通知 1 件。tenantId / createdBy 等の運営内部
 * 情報は backend の NotificationView shape で構造的に削られているのでここでは出ない。
 */
export interface NotificationView {
  readonly notificationId: string;
  readonly title: string;
  readonly body: string;
  readonly severity: "info" | "warning";
  readonly occurredAt: string;
}

export interface NotificationsResponse {
  readonly eventId: string;
  readonly items: readonly NotificationView[];
}

/**
 * `GET /portal/me/notifications?limit=` を `Authorization: Bearer <teamLoginKey>` で呼ぶ。
 * occurredAt 降順で最大 200 件。`limit` 未指定なら backend 側 default (100)。
 *
 * 旧 jobId-based deployment で eventId が無い場合は 404 (no_event) → `undefined`。
 * 新 deployment では空でも `{ items: [] }` が返るので `null` ではなく `undefined` で no-event と区別できる。
 */
export async function getNotifications(
  apiBaseUrl: string,
  teamLoginKey: string,
  limit?: number,
  signal?: AbortSignal,
): Promise<NotificationsResponse | undefined> {
  const query: Record<string, string> = {};
  if (limit !== undefined) query.limit = String(limit);
  return await portalFetch<NotificationsResponse>(
    apiBaseUrl,
    "portal/me/notifications",
    teamLoginKey,
    { query, throwOn400: true, returnUndefinedOn404: true, signal },
  );
}

/**
 * Phase 2c: Flag 提出は `problemId` 必須に。`POST /portal/me/submit-flag { problemId, flag }`。
 */
export async function submitFlag(
  apiBaseUrl: string,
  teamLoginKey: string,
  problemId: string,
  flag: string,
  signal?: AbortSignal,
): Promise<SubmitFlagOutcome> {
  return (await portalFetch<SubmitFlagOutcome>(apiBaseUrl, "portal/me/submit-flag", teamLoginKey, {
    method: "POST",
    body: { problemId, flag },
    throwOn400: true,
    signal,
  })) as SubmitFlagOutcome;
}
