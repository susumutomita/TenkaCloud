import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { DeploymentItem, DeploymentStatus } from "../deploy-handler/types.js";
import { DELETED_LIKE_STATUSES } from "../shared/constants.js";
import type { ScoreEventItem } from "../shared/score-event.js";
import { type ParticipantSharedResources, queryTeamItems } from "./shared.js";

/** participant 向けに公開する score event 1 行 (内部 PK/SK 等は出さない)。 */
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

export type ScoreEventsOutcome =
  | { kind: "ok"; response: ScoreEventsResponse }
  | { kind: "unauthorized" };

const DEFAULT_LIMIT = 100;

/**
 * teamLoginKey で team の全 deployment を引き、各 PK 配下の `EVENT#` SK 行を並列で
 * query して時系列降順 (occurredAt desc) でマージする。
 *
 * GSI を新設せず base table の PK + begins_with(SK, "EVENT#") query で済ます。
 * team 内の deployment 数は典型 <10 なので並列 N query は許容。
 *
 * teamId / eventId / tenantId / awsAccountId 等の operator 内部情報は **絶対に出さない**
 * (= ScoreEventView に存在しない field なので構造的に漏れない)。
 */
export async function listScoreEvents(
  shared: ParticipantSharedResources,
  teamLoginKey: string,
  limit: number = DEFAULT_LIMIT,
): Promise<ScoreEventsOutcome> {
  const myItems = await queryTeamItems(shared, teamLoginKey);
  if (myItems.length === 0) return { kind: "unauthorized" };

  // editable な (live) 行のみから event 行を引く。DELETING / DELETED の親は無視。
  const liveJobs = myItems.filter((i) => {
    const status = (i.status ?? "PENDING") as DeploymentStatus;
    return !DELETED_LIKE_STATUSES.has(status) && typeof i.PK === "string" && i.jobId;
  }) as Array<Pick<DeploymentItem, "PK" | "jobId">>;

  if (liveJobs.length === 0) return { kind: "unauthorized" };

  // 各 deployment の event 行を並列に query。N query を Promise.all で発火。
  // attack-detected 行 (ADR-005 D2-A) は同 EVENT# partition に共存し、`toView` で
  // undefined になる。Limit は scan 量に効くので、そのまま 100 にすると markers が
  // 詰まったときに valid scoring 行が押し出される。LastEvaluatedKey で paginate して
  // valid 行が limit 件集まる (or 親なし) まで読む。MAX_PAGES で暴走防止。
  const MAX_PAGES = 5;
  const eventChunks = await Promise.all(
    liveJobs.map(async (job) => {
      const collected: ScoreEventView[] = [];
      let exclusiveStart: Record<string, unknown> | undefined;
      let pages = 0;
      while (collected.length < limit && pages < MAX_PAGES) {
        const out = await shared.ddb.send(
          new QueryCommand({
            TableName: shared.tableName,
            KeyConditionExpression: "PK = :pk AND begins_with(SK, :evpfx)",
            ExpressionAttributeValues: {
              ":pk": job.PK,
              ":evpfx": "EVENT#",
            },
            ScanIndexForward: false,
            Limit: limit,
            ExclusiveStartKey: exclusiveStart,
          }),
        );
        for (const item of (out.Items ?? []) as Partial<ScoreEventItem>[]) {
          const v = toView(item);
          if (v) collected.push(v);
        }
        exclusiveStart = out.LastEvaluatedKey as Record<string, unknown> | undefined;
        pages++;
        if (!exclusiveStart) break;
      }
      return collected;
    }),
  );

  const merged = eventChunks.flat();
  // occurredAt 降順 sort + 全 deployment 横断の上位 limit 件を返す。
  merged.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0));
  const entries = merged.slice(0, limit);
  return { kind: "ok", response: { entries } };
}

/** ScoreEventItem (DDB row) → ScoreEventView (公開 shape)。不正な行は undefined。 */
function toView(item: Partial<ScoreEventItem>): ScoreEventView | undefined {
  if (typeof item.jobId !== "string") return undefined;
  if (typeof item.problemId !== "string") return undefined;
  if (item.source !== "uptime" && item.source !== "flag") return undefined;
  if (item.result !== "ok") return undefined;
  if (typeof item.occurredAt !== "string") return undefined;
  return {
    jobId: item.jobId,
    problemId: item.problemId,
    source: item.source,
    points: Number(item.points ?? 0),
    result: item.result,
    occurredAt: item.occurredAt,
  };
}
