/**
 * Participant Portal の polling 間隔定数 (cost guardrail)。
 *
 * 旧来は ScoreTimelineChart / ScoreEvents / TeamViewProvider に同じリテラルが copy-paste
 * されていたのを 1 箇所へ集約する (DRY)。 値の意味 (なぜこの間隔か) はここに残す。
 */

/**
 * opt-in status refresh の間隔。 旧 5 秒 polling は 12 req/min/team で過多だったため使わない。
 * Score / Leaderboard / Score-events の auto refresh はすべてこの 30 秒 tick に乗せる。
 */
export const POLL_INTERVAL_MS = 30_000;

/**
 * Notifications だけは 60 秒間隔で polling する (ADR-006 D3 + codex review)。
 * Events table は 1 RCU PROVISIONED なので、N 競技者 × 5 秒 polling で簡単に throttle
 * を引き起こす。Score / Leaderboard と同じ tick (30 秒) には乗せない。
 */
export const NOTIFICATIONS_POLL_INTERVAL_MS = 60_000;

/**
 * Local-play runtime startup polling. This is intentionally separate from the opt-in
 * AWS-backed status polling above: lifecycle fields only exist in local mode, and the
 * browser must observe the asynchronous Docker build completing before it can expose
 * the problem endpoints.
 */
export const LOCAL_LIFECYCLE_POLL_INTERVAL_MS = 1_000;
