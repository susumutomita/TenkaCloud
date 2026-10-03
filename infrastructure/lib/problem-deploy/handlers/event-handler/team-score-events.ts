import type { DeploymentsScoringPort } from "../../control-data/deployments-repository.js";
import { type ScoreEventItem, toPublicScoreEventView } from "../shared/score-event.js";
import { type EventSharedResources, resolveDeploymentsRepository } from "./shared.js";
import type { TeamScoreEvents, TeamScoreEventView } from "./types.js";

/**
 * Issue #1038 P1 #7: operator (= tenant admin) 視点で同 event の全 team の score event timeline
 * を 1 回でまとめて取得する。 participant 側 `/portal/leaderboard/score-events` (PR-1048) と
 * 同 shape で、 違いは認可境界 (= bearer ではなく tenant API GW + Cognito JWT 経由)。
 *
 * Deployments table の per-PK partition (= 1 deployment 1 partition) を並列 query。
 * 1 team あたり最大 200 events で打ち止め、 各 deployment 最大 3 page まで読む。 MVP 規模
 * (= 10 teams × 5 problems = 50 deployments) で 1 request あたり 50〜150 query、 30s polling
 * 想定で許容範囲。
 *
 * `deployments` は `getEventDetail` が既に GSI1 で fetch している rows を再利用して渡す
 * (= 同じ table を 2 回読みに行かない)。
 */
const PER_TEAM_LIMIT = 200;
const MAX_PAGES_PER_DEPLOYMENT = 3;

export interface DeploymentRefForScoreEvents {
  readonly jobId: string;
  readonly teamId: string;
  readonly teamName?: string;
}

/**
 * 全 team の score event timeline を構築する。 teams[] (= EventDetail.teams) を渡して
 * 表示順 / displayName を継承する。 teamId 不明な deployment は捨てる (= safety)。
 */
export async function collectTeamScoreEvents(
  shared: Pick<EventSharedResources, "runtime" | "ddb" | "deploymentsTableName">,
  args: {
    readonly deployments: readonly DeploymentRefForScoreEvents[];
    readonly displayNameByTeamId: ReadonlyMap<string, string>;
  },
): Promise<TeamScoreEvents[]> {
  // teamId → { teamName, deploymentJobIds[] }
  const byTeam = new Map<string, { teamName: string; deploymentJobIds: string[] }>();
  for (const d of args.deployments) {
    if (!d.jobId || !d.teamId) continue;
    let bucket = byTeam.get(d.teamId);
    if (!bucket) {
      bucket = {
        teamName: args.displayNameByTeamId.get(d.teamId) ?? d.teamName ?? d.teamId,
        deploymentJobIds: [],
      };
      byTeam.set(d.teamId, bucket);
    }
    bucket.deploymentJobIds.push(d.jobId);
  }

  const teams: TeamScoreEvents[] = await Promise.all(
    [...byTeam.entries()].map(async ([teamId, meta]) => {
      const collected = await collectEventsForDeployments(shared, meta.deploymentJobIds);
      collected.sort((a, b) =>
        a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0,
      );
      return {
        teamId,
        teamName: meta.teamName,
        events: collected.slice(0, PER_TEAM_LIMIT),
      };
    }),
  );

  // teamId 昇順で安定化 (= leaderboard と違って operator 視点は team 順序が「総合 score 順」 で
  // なくても良いが、 重複描画や順序のブレを避けるため teamId をキーに昇順 sort)。
  teams.sort((a, b) => a.teamId.localeCompare(b.teamId));

  return teams;
}

async function collectEventsForDeployments(
  shared: Pick<EventSharedResources, "runtime" | "ddb" | "deploymentsTableName">,
  deploymentJobIds: readonly string[],
): Promise<TeamScoreEventView[]> {
  const collected: TeamScoreEventView[] = [];
  const deployments: DeploymentsScoringPort = await resolveDeploymentsRepository(shared);
  await Promise.all(
    deploymentJobIds.map(async (jobId) => {
      // 1 deployment partition あたり最大 MAX_PAGES_PER_DEPLOYMENT ページまで drain (= 1 request
      // あたりの query 回数を bound)。全 team 合算後に caller が PER_TEAM_LIMIT で truncate する。
      const rows = await deployments.listScoreEvents(jobId, {
        pageSize: PER_TEAM_LIMIT,
        maxPages: MAX_PAGES_PER_DEPLOYMENT,
      });
      for (const it of rows as Partial<ScoreEventItem>[]) {
        const v = toPublicScoreEventView(it);
        if (v) collected.push(v);
      }
    }),
  );
  return collected;
}
