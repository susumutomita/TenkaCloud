import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { DeploymentItem, DeploymentStatus } from "../deploy-handler/types.js";
import { DELETED_LIKE_STATUSES } from "../shared/constants.js";
import { type ParticipantSharedResources, queryTeamItems } from "./shared.js";

/**
 * Leaderboard 1 行 (1 team の集計)。
 *
 * 競技者向けに公開しても安全な情報のみ:
 *   - displayTeamName / internalSlug 由来の表示名
 *   - そのチームの累計 score (live な deployment 行の合計)
 *   - 完了済 problem 数 (status=COMPLETE の数)
 *
 * teamLoginKey / tenantId / awsAccountId 等の運営情報は **絶対に出さない**。
 * teamId は同 event 内の同定に使うが、推測困難な ULID なので公開で問題ない。
 */
export interface LeaderboardEntry {
  readonly rank: number;
  readonly teamId: string;
  readonly teamName: string;
  readonly score: number;
  readonly completedProblems: number;
  readonly totalProblems: number;
  /** 同 event 内で requester 自身のチームなら true (= UI でハイライト用)。 */
  readonly isMyTeam: boolean;
}

export interface LeaderboardResponse {
  readonly eventId: string;
  readonly entries: readonly LeaderboardEntry[];
}

/**
 * `getLeaderboard` の結果。Phase 1 以前の旧 deployment (eventId 無し) は
 * leaderboard 不能なので `no_event` を返して 404 化する。
 */
export type LeaderboardOutcome =
  | { kind: "ok"; response: LeaderboardResponse }
  | { kind: "unauthorized" }
  | { kind: "no_event" };

/**
 * teamLoginKey から requester の team を特定し、同 event 内の全 team の score 集計を返す。
 *
 * 流れ:
 *   1. GSI2 (TEAMKEY#<key>) で requester 行を引く → tenantId / eventId / 自 teamId 取得
 *   2. GSI1 (TENANT#<tenantId>) + FilterExpression で同 event の全 deployment 行を取得
 *   3. teamId 単位で集計 (score 合計 / COMPLETE 数 / 表示名 / 全 problem 数)
 *   4. score 降順 + 同点は teamName 昇順で安定 sort、rank を付与
 *
 * GSI eventually consistent で直近 schedule された startsAt 等の伝播ラグはあるが、
 * leaderboard は順位表示のみなのでズレは許容範囲 (HealthCheck の 1 分周期に同期)。
 */
export async function getLeaderboard(
  shared: ParticipantSharedResources,
  teamLoginKey: string,
): Promise<LeaderboardOutcome> {
  const myItems = await queryTeamItems(shared, teamLoginKey);
  if (myItems.length === 0) return { kind: "unauthorized" };

  // 自 team の代表値 (= 最初の live 行) から tenantId / eventId / 自 teamId を引く。
  const sample = myItems.find((i) => {
    const status = (i.status ?? "PENDING") as DeploymentStatus;
    return !DELETED_LIKE_STATUSES.has(status);
  });
  if (!sample) return { kind: "unauthorized" };

  const tenantId = typeof sample.tenantId === "string" ? sample.tenantId : undefined;
  const eventId = typeof sample.eventId === "string" ? sample.eventId : undefined;
  const myTeamId = typeof sample.teamId === "string" ? sample.teamId : undefined;
  if (!tenantId || !eventId || !myTeamId) {
    // Phase 1 以前の旧 jobId-based deployment は eventId / teamId を持たないため
    // event scope の leaderboard を組めない。
    return { kind: "no_event" };
  }

  // tenant の全 deployment を引いて event 内のものだけ。FilterExpression は post-read
  // なので RCU は変わらないが network / Lambda 内処理量を節約。
  const out = await shared.ddb.send(
    new QueryCommand({
      TableName: shared.tableName,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      FilterExpression: "eventId = :ev",
      ExpressionAttributeValues: {
        ":pk": `TENANT#${tenantId}`,
        ":ev": eventId,
      },
    }),
  );
  const eventDeployments = (out.Items ?? []) as Partial<DeploymentItem>[];

  return {
    kind: "ok",
    response: { eventId, entries: buildLeaderboardEntries(eventDeployments, myTeamId) },
  };
}

/**
 * Deployments を team で group して集計し、score 降順 (同点は teamName 昇順) でソート + rank 付与。
 * `myTeamId` の team を `isMyTeam=true` でマーク。
 *
 * Pure function: caller が予め fetch した items を渡せば leaderboard を組み立てる。
 * テスト容易性のため export。
 */
export function buildLeaderboardEntries(
  items: readonly Partial<DeploymentItem>[],
  myTeamId: string,
): LeaderboardEntry[] {
  type Bucket = {
    teamId: string;
    teamName: string;
    score: number;
    completedProblems: number;
    totalProblems: number;
  };
  const byTeam = new Map<string, Bucket>();

  for (const item of items) {
    if (typeof item.teamId !== "string") continue;
    const status = (item.status ?? "PENDING") as DeploymentStatus;
    if (DELETED_LIKE_STATUSES.has(status)) continue;

    const teamId = item.teamId;
    const display = typeof item.displayTeamName === "string" ? item.displayTeamName : undefined;
    const operatorSlug = typeof item.teamName === "string" ? item.teamName : "";
    const teamName = display ?? operatorSlug;

    let bucket = byTeam.get(teamId);
    if (!bucket) {
      bucket = {
        teamId,
        teamName,
        score: 0,
        completedProblems: 0,
        totalProblems: 0,
      };
      byTeam.set(teamId, bucket);
    } else if (display && bucket.teamName !== display) {
      // displayTeamName を持つ行が後から見つかったら採用 (= 全行同期されている前提だが防御)
      bucket.teamName = display;
    }
    bucket.totalProblems += 1;
    bucket.score += Number(item.score ?? 0);
    if (status === "COMPLETE") bucket.completedProblems += 1;
  }

  const sorted = [...byTeam.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.teamName.localeCompare(b.teamName);
  });

  return sorted.map((bucket, idx) => ({
    rank: idx + 1,
    teamId: bucket.teamId,
    teamName: bucket.teamName,
    score: bucket.score,
    completedProblems: bucket.completedProblems,
    totalProblems: bucket.totalProblems,
    isMyTeam: bucket.teamId === myTeamId,
  }));
}
