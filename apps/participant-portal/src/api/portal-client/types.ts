/**
 * Portal API の domain 型定義。 `dev-mock-fixtures` / `lib/category.ts` 等の
 * 「型のみ参照」 callers はこのファイルだけを import すれば足りるようにする。
 *
 * Issue #2203: backend `ParticipantTeamView` 等と 1:1 対応していた手写しミラー型は
 * `@tenkacloud/portal-contracts` に移設し、 backend (participant-handler) と本 SPA が
 * 同一定義を import する (= field 追加の無音ドリフト #2198 を typecheck で検出)。
 * まだ移設していない view 型 (score-events / sso / battle-attacks / notifications /
 * reveal-hint / endpoints 系) はこのファイルに残る — 後続 Issue で移設する。
 */

export {
  type ApplicationStatus,
  type ApplicationStatusOverall,
  type AttackProbeOutcome,
  type AttackProbeResult,
  type DeploymentLogEntry,
  type DeploymentStatus,
  type HintRevealMode,
  type LeaderboardEntry,
  type LeaderboardResponse,
  type MultiFlagEntryView,
  type ParticipantHintView,
  type ParticipantProblemView,
  type ParticipantProgressionView,
  type ParticipantScoringInfo,
  type ParticipantTeamView,
  type ProblemRuntimeKind,
  type ScoringKind,
  type SubmitFlagOutcome,
  TERMINAL_STATUSES,
} from "@tenkacloud/portal-contracts";

import type { DeploymentLogEntry, ParticipantProblemView } from "@tenkacloud/portal-contracts";

/**
 * [#2392 Phase 2] local-play on-demand container lifecycle。 `lifecycle` は
 * `ParticipantProblemView` の optional field (不在 = AWS mode = 常時 running 扱い)。
 * union を手写しせず contract から導出する (= drift を typecheck で検出)。
 */
export type ProblemLifecycleStatus = NonNullable<ParticipantProblemView["lifecycle"]>["status"];

/** `POST /portal/me/problems/:id/start` / `.../stop` / `.../reset` の応答 body。 */
export interface ProblemLifecycleActionResponse {
  readonly status: ProblemLifecycleStatus;
}

export interface DeployLogsResponse {
  readonly jobId: string;
  readonly buildStatus?: string;
  readonly complete: boolean;
  readonly nextToken?: string;
  readonly entries: readonly Omit<DeploymentLogEntry, "level">[];
}

export type AssumeRoleStage = "competitor" | "participant_viewer";

/**
 * Phase 3: 自チームのスコア変動履歴 (時系列降順)。
 * Issue #1001: flag 提出 / uptime probe 成功に加え、 ヒント開封 / 不正解 flag の
 * 減点行も含む。 source / points の符号で 「加点 / 減点」 を区別する。
 * Issue #2283: Progression Gate 完了時の 1 回限り bonus は source="gate-bonus" で届く。
 */
export interface ScoreEventView {
  readonly jobId: string;
  readonly problemId: string;
  readonly source: "uptime" | "flag" | "flag-wrong" | "hint" | "gate-bonus" | "coordination";
  readonly reason?: string;
  readonly points: number;
  readonly result: "ok" | "wrong";
  readonly occurredAt: string;
}

export interface ScoreEventsResponse {
  readonly entries: readonly ScoreEventView[];
}

/**
 * Issue #1038 P1 #6: 全チームの累計スコア推移を返す endpoint の view shape。
 *
 * - `teamId` は ULID (= 推測困難)、 leaderboard と同じ
 * - `teamName` は displayTeamName ?? slug
 * - `events` は occurredAt 昇順 (= chart の cumulative 累積を 1 pass で組める)
 * - source / result は `ScoreEventView` と同じ source 包含 (#2283 で "gate-bonus" 追加)
 */
export interface TeamScoreEventView {
  readonly jobId: string;
  readonly problemId: string;
  readonly source: "uptime" | "flag" | "flag-wrong" | "hint" | "gate-bonus" | "coordination";
  readonly reason?: string;
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
 * 自 team の指定 deployment における attack-detected event の participant-safe な時系列。
 * Battle Portal の Attack Statistics / Attack History タブが poll する。
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
 * Notifications API: 運営 → 競技者 通知 1 件。tenantId / createdBy 等の運営内部
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
 * Endpoint registry API client。 1 problem の slot 一覧 (= default URL +
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
