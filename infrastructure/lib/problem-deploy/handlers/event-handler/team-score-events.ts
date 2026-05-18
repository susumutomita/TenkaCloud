import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { ScoreEventItem } from "../shared/score-event.js";
import type { EventSharedResources } from "./shared.js";
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
  readonly PK: string;
  readonly teamId: string;
  readonly teamName?: string;
}

/**
 * 全 team の score event timeline を構築する。 teams[] (= EventDetail.teams) を渡して
 * 表示順 / displayName を継承する。 teamId 不明な deployment は捨てる (= safety)。
 */
export async function collectTeamScoreEvents(
  shared: Pick<EventSharedResources, "ddb" | "deploymentsTableName">,
  args: {
    readonly deployments: readonly DeploymentRefForScoreEvents[];
    readonly displayNameByTeamId: ReadonlyMap<string, string>;
  },
): Promise<TeamScoreEvents[]> {
  // teamId → { teamName, deploymentPKs[] }
  const byTeam = new Map<string, { teamName: string; deploymentPKs: string[] }>();
  for (const d of args.deployments) {
    if (!d.PK || !d.teamId) continue;
    let bucket = byTeam.get(d.teamId);
    if (!bucket) {
      bucket = {
        teamName: args.displayNameByTeamId.get(d.teamId) ?? d.teamName ?? d.teamId,
        deploymentPKs: [],
      };
      byTeam.set(d.teamId, bucket);
    }
    bucket.deploymentPKs.push(d.PK);
  }

  const teams: TeamScoreEvents[] = await Promise.all(
    [...byTeam.entries()].map(async ([teamId, meta]) => {
      const collected = await collectEventsForDeployments(shared, meta.deploymentPKs);
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
  shared: Pick<EventSharedResources, "ddb" | "deploymentsTableName">,
  deploymentPKs: readonly string[],
): Promise<TeamScoreEventView[]> {
  const collected: TeamScoreEventView[] = [];
  await Promise.all(
    deploymentPKs.map(async (pk) => {
      let exclusiveStart: Record<string, unknown> | undefined;
      let pages = 0;
      while (pages < MAX_PAGES_PER_DEPLOYMENT && collected.length < PER_TEAM_LIMIT) {
        const out = await shared.ddb.send(
          new QueryCommand({
            TableName: shared.deploymentsTableName,
            KeyConditionExpression: "PK = :pk AND begins_with(SK, :evpfx)",
            ExpressionAttributeValues: { ":pk": pk, ":evpfx": "EVENT#" },
            ScanIndexForward: false,
            Limit: PER_TEAM_LIMIT,
            ExclusiveStartKey: exclusiveStart,
          }),
        );
        for (const it of (out.Items ?? []) as Partial<ScoreEventItem>[]) {
          const v = toView(it);
          if (v) collected.push(v);
        }
        exclusiveStart = out.LastEvaluatedKey as Record<string, unknown> | undefined;
        pages++;
        if (!exclusiveStart) break;
      }
    }),
  );
  return collected;
}

const ALLOWED_SOURCES = new Set<TeamScoreEventView["source"]>([
  "uptime",
  "flag",
  "flag-wrong",
  "hint",
]);
const ALLOWED_RESULTS = new Set<TeamScoreEventView["result"]>(["ok", "wrong"]);

function toView(item: Partial<ScoreEventItem>): TeamScoreEventView | undefined {
  if (typeof item.jobId !== "string") return undefined;
  if (typeof item.problemId !== "string") return undefined;
  if (typeof item.source !== "string") return undefined;
  if (!ALLOWED_SOURCES.has(item.source as TeamScoreEventView["source"])) return undefined;
  if (typeof item.result !== "string") return undefined;
  if (!ALLOWED_RESULTS.has(item.result as TeamScoreEventView["result"])) return undefined;
  if (typeof item.occurredAt !== "string") return undefined;
  return {
    jobId: item.jobId,
    problemId: item.problemId,
    source: item.source as TeamScoreEventView["source"],
    points: Number(item.points ?? 0),
    result: item.result as TeamScoreEventView["result"],
    occurredAt: item.occurredAt,
  };
}
