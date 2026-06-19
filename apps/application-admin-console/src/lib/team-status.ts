/**
 * Issue #1916: operator が disruption を「いつ」撃つかを判断するための per-team status を、
 * 既存の tenant-scoped read だけから組み立てる pure helper。
 *
 * - score / rank / solved 数 → `event-report-stats.buildScoreboard` を再利用 (ranking contract
 *   を 1 箇所に保つ)。
 * - deploy 状況 → `EventDetail.deploymentsByProblem` を team 単位で集計。
 * - 直近の採点結果 → `EventDetail.scoreEventsByTeam` の末尾 event (occurredAt 昇順なので末尾が最新)。
 * - 撃ち込んだ disruption 履歴 → disruption audit を team 単位で集計。
 *
 * React import を持たず lib-side に置くことで、 集計ロジックを単体テストできる
 * (`lib/event-report-stats.ts` と同じ役割分担: lib で数を出し、 pages/components で描画)。
 */

import type { DisruptionAuditRow } from "../api/disruptions-client";
import type { EventDeploymentStatus, EventDetail } from "../api/events-client";
import { buildScoreboard } from "./event-report-stats";

export interface TeamDeployStatus {
  /** この team の deployment 行総数 (= 出題された問題数)。 */
  readonly total: number;
  /** いま稼働中 (`COMPLETE`) の数。 attack が刺さる前提が整っているか。 */
  readonly complete: number;
  /** `FAILED` / `EXPIRED` の数。 */
  readonly failed: number;
  /** `PENDING` / `IN_PROGRESS` の数 (= まだ立ち上げ中)。 */
  readonly inProgress: number;
}

export interface TeamLatestScoring {
  readonly result: "ok" | "wrong";
  readonly source: string;
  readonly occurredAt: string;
}

export interface TeamStatusRow {
  readonly rank: number;
  readonly teamId: string;
  readonly teamName: string;
  readonly totalScore: number;
  readonly problemsSolved: number;
  readonly deploy: TeamDeployStatus;
  /** 直近の採点 event。 まだ 1 件も無ければ null。 */
  readonly latest: TeamLatestScoring | null;
  /** この team を対象に撃たれた disruption の件数 (audit の取得 window 内)。 */
  readonly disruptionsFired: number;
  /** 最後に撃たれた時刻 (ISO8601)。 未撃なら null。 */
  readonly lastFiredAt: string | null;
}

/** deploy status を status table の bucket に振り分ける (total は別途数える)。 */
function deployBucket(status: EventDeploymentStatus): "complete" | "failed" | "inProgress" | null {
  if (status === "COMPLETE") return "complete";
  if (status === "FAILED" || status === "EXPIRED") return "failed";
  if (status === "PENDING" || status === "IN_PROGRESS") return "inProgress";
  return null;
}

function deployForTeam(detail: EventDetail, teamId: string): TeamDeployStatus {
  const acc = { total: 0, complete: 0, failed: 0, inProgress: 0 };
  for (const list of Object.values(detail.deploymentsByProblem)) {
    for (const deployment of list) {
      if (deployment.teamId !== teamId) continue;
      acc.total += 1;
      const bucket = deployBucket(deployment.status);
      if (bucket) acc[bucket] += 1;
    }
  }
  return acc;
}

function latestScoringForTeam(detail: EventDetail, teamId: string): TeamLatestScoring | null {
  const team = (detail.scoreEventsByTeam ?? []).find((t) => t.teamId === teamId);
  if (!team || team.events.length === 0) return null;
  // events は occurredAt 昇順 (events-client TeamScoreEvents の契約) なので末尾が最新。
  const last = team.events[team.events.length - 1];
  return { result: last.result, source: last.source, occurredAt: last.occurredAt };
}

function disruptionsForTeam(
  audit: readonly DisruptionAuditRow[],
  teamId: string,
): { readonly count: number; readonly lastFiredAt: string | null } {
  let count = 0;
  let lastFiredAt: string | null = null;
  for (const row of audit) {
    if (!row.targetTeamIds.includes(teamId)) continue;
    count += 1;
    // ISO8601 は辞書順 = 時系列順なので文字列比較で最新を取れる。
    if (lastFiredAt === null || row.firedAt > lastFiredAt) lastFiredAt = row.firedAt;
  }
  return { count, lastFiredAt };
}

export function assembleTeamStatus(
  detail: EventDetail,
  audit: readonly DisruptionAuditRow[],
): readonly TeamStatusRow[] {
  return buildScoreboard(detail.teams, detail.scoreEventsByTeam).map((row) => {
    const { count, lastFiredAt } = disruptionsForTeam(audit, row.teamId);
    return {
      rank: row.rank,
      teamId: row.teamId,
      teamName: row.teamName,
      totalScore: row.totalScore,
      problemsSolved: row.problemsSolved,
      deploy: deployForTeam(detail, row.teamId),
      latest: latestScoringForTeam(detail, row.teamId),
      disruptionsFired: count,
      lastFiredAt,
    };
  });
}
