/**
 * Portal API の domain 型定義。 backend `ParticipantTeamView` / `ScoreEventView` 等と
 * 1:1 で対応する shape を集約。 `dev-mock-fixtures` / `lib/category.ts` 等の
 * 「型のみ参照」 callers はこのファイルだけを import すれば足りるようにする。
 */

export type DeploymentStatus =
  | "PENDING"
  | "IN_PROGRESS"
  | "COMPLETE"
  | "FAILED"
  | "DELETING"
  | "DELETED"
  | "EXPIRED"
  | "AUTO_DELETED";

export const TERMINAL_STATUSES: ReadonlySet<DeploymentStatus> = new Set([
  "COMPLETE",
  "FAILED",
  "DELETED",
  "EXPIRED",
  "AUTO_DELETED",
]);

/**
 * ADR-012 で定義された 5 種の builtin scoring kind。
 * Phase 1 (旧 view) は flag / uptime のみだったが、 Phase 3 で phased-polling /
 * uptime-flat / uptime-multi / attack-detection が追加された。
 * UI 表示 (= categoryOf) は ADR-005 で Battle / Challenge の 2 軸に collapse する。
 */
export type ScoringKind =
  | "flag"
  | "multi-flag"
  | "uptime"
  | "uptime-flat"
  | "uptime-multi"
  | "phased-polling"
  | "attack-detection";

/**
 * Issue #1796: multi-flag の 1 sub-flag の view (= backend `ParticipantScoringInfo.flags[]` と
 * 同じ shape)。 正解値 (flagOutputKey の値) は含めない (= 答えを漏らさない)。 `solved` は team の
 * 解済 flag id 集合に含まれるかで判定済み。
 */
export interface MultiFlagEntryView {
  readonly id: string;
  readonly label: string;
  readonly points: number;
  readonly solved: boolean;
}

/**
 * Issue #742 Phase 4: progressive hint view shape (= backend
 * `ParticipantHintView` と同じ)。 revealed=false な hint は content 不在 (= 答えを
 * frontend に漏らさない)、 revealed=true は content + revealedAt を含む。
 */
export interface ParticipantHintView {
  readonly id: string;
  readonly penalty: number;
  readonly revealed: boolean;
  readonly content?: string;
  readonly revealedAt?: string;
}

export interface ParticipantScoringInfo {
  readonly kind: ScoringKind;
  readonly points?: number;
  readonly pointsPerSuccess?: number;
  readonly hints?: readonly ParticipantHintView[];
  readonly flagSubmitted?: boolean;
  /** Issue #1796: multi-flag の sub-flag 一覧 (= N 個の提出欄を出すための view)。 */
  readonly flags?: readonly MultiFlagEntryView[];
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

export interface DeploymentLogEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly source: "deployment" | "codebuild";
  readonly level: "info" | "success" | "warning" | "error";
  readonly message: string;
}

export interface DeploymentLogView {
  readonly cursor: string;
  readonly entries: readonly DeploymentLogEntry[];
}

export interface DeployLogsResponse {
  readonly jobId: string;
  readonly buildStatus?: string;
  readonly complete: boolean;
  readonly nextToken?: string;
  readonly entries: readonly Omit<DeploymentLogEntry, "level">[];
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
  readonly deployLog: DeploymentLogView;
  /** Issue #607: deploy 開始時刻 (DDB.createdAt の echo)。 portal の phase countdown が
   *  metadata.phases / disruptions の afterMinutes との差で残時間を計算する。 deploy 中の
   *  PENDING / IN_PROGRESS でも present。 */
  readonly createdAt?: string;
  /** ADR-005 Phase 3.1: Battle (uptime) のみ aggregate health を露出。 */
  readonly applicationStatus?: ApplicationStatus;
}

/**
 * Issue #1038 P0 #2: 競技開始前 / 終了 / 一時停止 の gate 状態を backend が
 * 計算して返す (= participant-handler `/portal/me`)。
 *
 * frontend は `kind: "scoring_not_started"` のとき ProblemDetail page を lock screen
 * (= 「競技開始前です」 表示) に切り替える。 backend 側で fail-closed を担保するので
 * eventId 不在 / gate 取得失敗時も "scoring_not_started" が返り、 不正アクセスを防ぐ。
 */
export type ParticipantEventGate =
  | { readonly kind: "ok" }
  | { readonly kind: "scoring_not_started"; readonly startsAt?: string }
  | { readonly kind: "scoring_ended"; readonly endsAt?: string }
  | { readonly kind: "scoring_locked" };

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
  /** Issue #1038 P0 #2: event gate (= 競技開始前 / 終了 / lock 中) status。 */
  readonly eventGate?: ParticipantEventGate;
}

export type SubmitFlagOutcome =
  /** Issue #1796: multi-flag のとき、 どの sub-flag が解けたかを示す `flagId` を含む。 */
  | { kind: "ok"; scoreDelta: number; totalScore: number; flagId?: string }
  | { kind: "already_scored"; totalScore: number }
  /**
   * Issue #817: 不正解。 問題 metadata に `wrongAnswerPenalty` が設定されていれば
   * `scoreDelta` は負数 (= 減点)。 設定されていなければ 0。 wrongCount は累計試行回数。
   */
  | { kind: "wrong"; scoreDelta: number; totalScore: number; wrongCount: number };

export type AssumeRoleStage = "competitor" | "participant_viewer";

/**
 * Phase 3: 自チームのスコア変動履歴 (時系列降順)。
 * Issue #1001: flag 提出 / uptime probe 成功に加え、 ヒント開封 / 不正解 flag の
 * 減点行も含む。 source / points の符号で 「加点 / 減点」 を区別する。
 */
export interface ScoreEventView {
  readonly jobId: string;
  readonly problemId: string;
  readonly source: "uptime" | "flag" | "flag-wrong" | "hint";
  readonly points: number;
  readonly result: "ok" | "wrong";
  readonly occurredAt: string;
}

export interface ScoreEventsResponse {
  readonly entries: readonly ScoreEventView[];
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
  /**
   * Issue #1038 P1 #9: scoreboard freeze (= 終了 30 分前から最終結果まで順位非公開)。
   * true なら frontend は entries を隠して「凍結中」 メッセージを表示する (= 終盤の
   * 駆け込み防止 + 競技公平性)。
   */
  readonly scoreboardFrozen?: boolean;
  /** event の終了予定時刻 (ISO 8601、 UI で「あと N 分で公開」 表示用)。 */
  readonly endsAt?: string;
}

/**
 * Issue #1038 P1 #6: 全チームの累計スコア推移を返す endpoint の view shape。
 *
 * - `teamId` は ULID (= 推測困難)、 leaderboard と同じ
 * - `teamName` は displayTeamName ?? slug
 * - `events` は occurredAt 昇順 (= chart の cumulative 累積を 1 pass で組める)
 * - source / result は `ScoreEventView` と同じ 4-source 包含
 */
export interface TeamScoreEventView {
  readonly jobId: string;
  readonly problemId: string;
  readonly source: "uptime" | "flag" | "flag-wrong" | "hint";
  readonly points: number;
  readonly result: "ok" | "wrong";
  readonly occurredAt: string;
}

export interface TeamScoreEvents {
  readonly teamId: string;
  readonly teamName: string;
  readonly isMyTeam: boolean;
  readonly events: readonly TeamScoreEventView[];
}

export interface LeaderboardScoreEventsResponse {
  readonly eventId: string;
  readonly teams: readonly TeamScoreEvents[];
}

/**
 * Issue #1197: CLI / SDK 用一時資格情報。 backend は Console federation と同じ 2 段
 * AssumeRole (= CompetitorDeployRole → ParticipantViewerRole) を実行し、 federation
 * endpoint を呼ばずに credentials を返す。
 *
 * UI は受け取った credentials を:
 *   - shell snippet (= `export AWS_ACCESS_KEY_ID=...`) として表示・コピー
 *   - 残り TTL countdown を表示 (= expiration ISO 8601)
 * の用途に使う。 localStorage 等への persist は避ける (= 漏洩窓を伸ばさない)。
 */
export interface CliCredentialsView {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  /** ISO 8601 string。 STS Credentials.Expiration を直接 echo。 */
  readonly expiration: string;
  readonly region: string;
  readonly awsAccountId: string;
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
 * Issue #742 Phase 4: progressive hint reveal API。 `POST /portal/me/problems/{problemId}/hints/{hintId}/reveal`。
 * 同 hintId 重複 reveal は idempotent (= 200 で kind=already_revealed)。
 */
export interface RevealHintResponse {
  readonly kind: "ok" | "already_revealed";
  readonly content: string;
  readonly penaltyApplied: number;
  readonly totalScore: number;
  readonly revealedAt?: string;
}

/**
 * ADR-012 Phase 3.A: Endpoint registry API client。 1 problem の slot 一覧 (= default URL +
 * override URL + effective URL の集約 view) を返す。 競技者 portal で「自チームの endpoint」 panel
 * を render するために使う。
 */
export interface ParticipantEndpointView {
  readonly slot: string;
  readonly overridable: boolean;
  readonly label?: string;
  readonly description?: string;
  /**
   * #703 診断用: 該当 slot の default URL を引く元 CFn Output key (= metadata.endpoints[i].default.key)。
   * defaultUrl が undefined (= deploy 未完 / template Output 未宣言) のとき UI で「{key} 待ち」と
   * 表示するために露出。 metadata.json 由来なので機密ではない。
   */
  readonly defaultKey: string;
  readonly defaultUrl?: string;
  readonly overrideUrl?: string;
  readonly effectiveUrl?: string;
}

export interface ParticipantEndpointsResponse {
  readonly teamId: string;
  readonly endpoints: readonly ParticipantEndpointView[];
}
