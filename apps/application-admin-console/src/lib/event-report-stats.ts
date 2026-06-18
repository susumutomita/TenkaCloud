/**
 * Pure helpers used by the printable Event Report page (`/events/:eventId/report`).
 *
 * Kept lib-side (= no React import) so the math is unit-testable in isolation and the
 * page component stays focused on layout / print CSS. Mirrors the role split in
 * `lib/event-wizard.ts`: derive numbers in `lib/`, render in `pages/`.
 */

import type {
  EventDeploymentStatus,
  EventDeploymentSummary,
  EventDetail,
  TeamScoreEvents,
  TeamSummary,
} from "../api/events-client";

/**
 * 「deploy が成功した」 とみなす status。`COMPLETE` は現役、 `AUTO_DELETED` / `DELETED` / `DELETING`
 * は「一度 deploy に成功した後にクリーンアップされた / 中」 (= 自動失効 / 手動 teardown)。最終 report
 * は「deploy できたか」 を測る指標なので、 競技終了後に teardown した成功 deploy も成功として数える
 * (= 成功した問題を片付けた後に「成功 0」 と表示される不具合の修正)。
 *
 * 注: deployment 行は削除後に削除前 outcome を保持せず status のみを持つため、 仮に FAILED を
 * teardown した行も `DELETED` として成功に数える可能性がある。 これは既存の `AUTO_DELETED`=成功 と
 * 同じ近似で、 通常運用 (= 成功 deploy を終了時に片付ける) を正しく数えることを優先する。
 */
const SUCCESSFUL_DEPLOY_STATUSES: ReadonlySet<EventDeploymentStatus> = new Set([
  "COMPLETE",
  "AUTO_DELETED",
  "DELETED",
  "DELETING",
]);

function isSuccessfulDeploy(status: EventDeploymentStatus): boolean {
  return SUCCESSFUL_DEPLOY_STATUSES.has(status);
}

export interface EventReportSummary {
  /** team 数 = `EventDetail.teams.length`。 */
  readonly teamCount: number;
  /**
   * participant 数。本 platform は per-team Bearer key 配布なので個人 account を持たない。
   * 「参加者 = team 単位の人数」 として teamCount で代表値を出す (= 表示上は team count と
   * 同じ; 将来 per-participant 集計を入れる時に分離可能なように field を分けてある)。
   */
  readonly participantCount: number;
  /** 問題数 = `EventDetail.problems.length`。 */
  readonly problemCount: number;
  /** 全 problem × 全 team を bulk-deploy した結果の deployment 行総数。 */
  readonly totalDeployments: number;
  /** deploy に成功した deployment 数 (= `COMPLETE` / `AUTO_DELETED` / `DELETED` / `DELETING`)。 */
  readonly successfulDeployments: number;
  /** `FAILED` または `EXPIRED` の deployment 数。 */
  readonly failedDeployments: number;
  /**
   * successRate = successful / total (0〜1)。 deployment が 0 件のときは 0 を返す
   * (= 「未 deploy」 と 「全成功」 を取り違えないよう、 呼び出し側で totalDeployments と
   * 併せて判断する)。
   */
  readonly successRate: number;
}

export function summarizeEvent(detail: EventDetail): EventReportSummary {
  const teamCount = detail.teams.length;
  const problemCount = detail.problems.length;
  let totalDeployments = 0;
  let successfulDeployments = 0;
  let failedDeployments = 0;
  for (const list of Object.values(detail.deploymentsByProblem)) {
    for (const deployment of list) {
      totalDeployments += 1;
      if (isSuccessfulDeploy(deployment.status)) {
        successfulDeployments += 1;
      }
      if (deployment.status === "FAILED" || deployment.status === "EXPIRED") {
        failedDeployments += 1;
      }
    }
  }
  const successRate = totalDeployments === 0 ? 0 : successfulDeployments / totalDeployments;
  return {
    teamCount,
    participantCount: teamCount,
    problemCount,
    totalDeployments,
    successfulDeployments,
    failedDeployments,
    successRate,
  };
}

export interface ScoreboardRow {
  readonly rank: number;
  readonly teamId: string;
  readonly teamName: string;
  readonly totalScore: number;
  /** 「solved 数」 = correct flag (= source: "flag", result: "ok") の問題種類数 (重複排除済)。 */
  readonly problemsSolved: number;
}

/**
 * 最終 scoreboard を構築する。ranking ロジックは `TeamRankingPanel.computeRanking` と
 * 同 contract (= 累計点降順、 同点は last-update 早い方を上位)。 ここでは「solved 数」
 * column を追加するため、 同等の集計を再実装して dependency direction を保つ (UI component
 * → lib の片方向 import を維持)。
 */
export function buildScoreboard(
  teams: readonly TeamSummary[],
  scoreEvents: readonly TeamScoreEvents[] | undefined,
): readonly ScoreboardRow[] {
  const eventsByTeam = new Map<string, TeamScoreEvents>();
  if (scoreEvents) {
    for (const t of scoreEvents) {
      eventsByTeam.set(t.teamId, t);
    }
  }
  const aggregated = teams.map((team) => {
    const events = eventsByTeam.get(team.teamId)?.events ?? [];
    const totalScore = events.reduce((acc, e) => acc + e.points, 0);
    const solvedSet = new Set<string>();
    for (const ev of events) {
      if (ev.source === "flag" && ev.result === "ok") {
        solvedSet.add(ev.problemId);
      }
    }
    const lastUpdateMs =
      events.length > 0
        ? Math.max(...events.map((e) => Date.parse(e.occurredAt)).filter(Number.isFinite))
        : Number.POSITIVE_INFINITY;
    return {
      teamId: team.teamId,
      teamName: team.displayName ?? team.internalSlug,
      totalScore,
      problemsSolved: solvedSet.size,
      lastUpdateMs,
    };
  });
  const sorted = [...aggregated].sort((a, b) => {
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    return a.lastUpdateMs - b.lastUpdateMs;
  });
  let prevScore: number | null = null;
  let prevRank = 0;
  return sorted.map((row, idx) => {
    const rank = prevScore !== null && row.totalScore === prevScore ? prevRank : idx + 1;
    prevScore = row.totalScore;
    prevRank = rank;
    return {
      rank,
      teamId: row.teamId,
      teamName: row.teamName,
      totalScore: row.totalScore,
      problemsSolved: row.problemsSolved,
    };
  });
}

export interface ProblemBreakdownRow {
  readonly problemId: string;
  /**
   * deploy 先 region (= `EventProblemTarget.defaultRegion`)。 category / kind は EventDetail
   * から取れないため report では problemId を identity として扱う。
   */
  readonly defaultRegion: string;
  /** 「この problem を 1 つでも flag 解いた team の数」。 */
  readonly solvedCount: number;
  /** この problem に対する全 team の累計得点を team 数で割った平均 (= 0 team 時は 0)。 */
  readonly avgScore: number;
  /** この problem 配下の deployment 行数 (= 全 team 分の deploy attempt 数)。 */
  readonly deploymentsCount: number;
  /** deploy に成功した deployment 数 (= COMPLETE / AUTO_DELETED / DELETED / DELETING)。 */
  readonly successfulCount: number;
}

interface PerTeamProblemAgg {
  /** この team が当該 problem で正答 flag を 1 つ以上獲得したか。 */
  readonly solved: boolean;
  /** この team が当該 problem に対して獲得した累計点 (= 全 source 合算)。 */
  readonly points: number;
}

function aggregateTeamForProblem(team: TeamScoreEvents, problemId: string): PerTeamProblemAgg {
  let solved = false;
  let points = 0;
  for (const ev of team.events) {
    if (ev.problemId !== problemId) continue;
    points += ev.points;
    if (ev.source === "flag" && ev.result === "ok") solved = true;
  }
  return { solved, points };
}

function countSuccessful(deployments: readonly EventDeploymentSummary[]): number {
  return deployments.filter((d) => isSuccessfulDeploy(d.status)).length;
}

export function buildProblemBreakdown(detail: EventDetail): readonly ProblemBreakdownRow[] {
  const scoreEvents = detail.scoreEventsByTeam ?? [];
  const teamCount = detail.teams.length;
  return detail.problems.map((problem) => {
    const aggs = scoreEvents.map((team) => aggregateTeamForProblem(team, problem.problemId));
    const solvedCount = aggs.filter((a) => a.solved).length;
    const totalPoints = aggs.reduce((acc, a) => acc + a.points, 0);
    const deployments: readonly EventDeploymentSummary[] =
      detail.deploymentsByProblem[problem.problemId] ?? [];
    return {
      problemId: problem.problemId,
      defaultRegion: problem.defaultRegion,
      solvedCount,
      avgScore: teamCount === 0 ? 0 : Math.round((totalPoints / teamCount) * 10) / 10,
      deploymentsCount: deployments.length,
      successfulCount: countSuccessful(deployments),
    };
  });
}

export interface DisruptionEntry {
  readonly occurredAt: string;
  readonly problemId: string;
  readonly teamId: string;
  readonly teamName: string;
  /** `flag-wrong` 等の event source。Red Team 風 timeline 用に source をそのまま見せる。 */
  readonly source: string;
  readonly points: number;
}

/**
 * 「disruption / Red Team log」 として現状利用可能な signal は、 採点ロジックが減点した
 * `flag-wrong` event。 platform-side に専用 disruption table は無いので、 negative-points
 * 系 event を timeline に並べて代用する。 該当が無ければ空配列を返し、 UI 側で section を隠す。
 */
export function buildDisruptionLog(detail: EventDetail): readonly DisruptionEntry[] {
  const out: DisruptionEntry[] = [];
  const scoreEvents = detail.scoreEventsByTeam ?? [];
  for (const team of scoreEvents) {
    for (const ev of team.events) {
      if (ev.source === "flag-wrong" || ev.points < 0) {
        out.push({
          occurredAt: ev.occurredAt,
          problemId: ev.problemId,
          teamId: team.teamId,
          teamName: team.teamName,
          source: ev.source,
          points: ev.points,
        });
      }
    }
  }
  return out.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
}

/**
 * 「Print Report」 button を出すべきかどうか。 spec: status が `ENDED` か `ARCHIVED` の
 * とき (= 競技終了後の deliverable 用途) のみ true。
 */
export function isReportReady(detail: EventDetail | null | undefined): boolean {
  if (!detail) return false;
  return detail.status === "ENDED" || detail.status === "ARCHIVED";
}

export function formatPercent(value: number, fractionDigits = 1): string {
  if (!Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(fractionDigits)}%`;
}
