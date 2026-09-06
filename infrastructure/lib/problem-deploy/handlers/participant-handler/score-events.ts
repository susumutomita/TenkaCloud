import type { DeploymentsScoringPort } from "../../control-data/deployments-repository.js";
import type { DeploymentItem, DeploymentStatus } from "../deploy-handler/types.js";
import { DELETED_LIKE_STATUSES } from "../shared/constants.js";
import {
  type PublicScoreEventView,
  type ScoreEventItem,
  toPublicScoreEventView,
} from "../shared/score-event.js";
import {
  type ParticipantSharedResources,
  queryTeamItems,
  resolveDeploymentsRepository,
} from "./shared.js";

/**
 * participant 向けに公開する score event 1 行 (内部 PK/SK 等は出さない)。
 *
 * Issue #1038 P1 #8 follow-up: hint reveal (= PR-1043) / 不正解 flag (Issue #817 で書き込み済)
 * は score を確かに動かすが、 旧 toView が `"uptime"` / `"flag"` のみ通過させていたため履歴に
 * 出てこなかった (= user 観測「ヒントひらいたときのスコアが score events 履歴に出ない」)。
 * `score-event.ts` の writer 側 union のうち competitor の累計 score に影響する 5 種
 * (uptime / flag / flag-wrong / hint / gate-bonus #2283) を公開する
 * (= `attack-detected` は marker 用、 frontend にスコア行として並べない)。
 */
export type ScoreEventView = PublicScoreEventView;

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
    return !DELETED_LIKE_STATUSES.has(status) && typeof i.jobId === "string";
  }) as Array<Pick<DeploymentItem, "jobId">>;

  if (liveJobs.length === 0) return { kind: "unauthorized" };

  // 各 deployment の event 行を並列に query。N query を Promise.all で発火。
  // attack-detected 行 は同 EVENT# partition に共存し、`toView` で
  // undefined になる。Limit は scan 量に効くので、そのまま 100 にすると markers が
  // 詰まったときに valid scoring 行が押し出される。LastEvaluatedKey で paginate して
  // valid 行が limit 件集まる (or 親なし) まで読む。MAX_PAGES で暴走防止。
  const MAX_PAGES = 5;
  const deployments: DeploymentsScoringPort = await resolveDeploymentsRepository(shared);
  const eventChunks = await Promise.all(
    liveJobs.map(async (job) => {
      const rows = await deployments.listScoreEvents(job.jobId, {
        pageSize: limit,
        maxPages: MAX_PAGES,
      });
      const collected: ScoreEventView[] = [];
      for (const item of rows as Partial<ScoreEventItem>[]) {
        const v = toPublicScoreEventView(item);
        if (v) collected.push(v);
        if (collected.length >= limit) break;
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
