import { ulid } from "ulid";
import type { ScoreEventRecord } from "../../control-data/domain/deployments.js";
import type { DeploymentItem } from "../deploy-handler/types.js";

/**
 * 1 採点イベント (= スコア加算 / 攻撃検知の単位) を Deployments table に書き込むときの shape。
 *
 *   PK = `DEPLOYMENT#<jobId>` (= 親 deployment と同じ partition)
 *   SK = `EVENT#<isoTimestamp>#<ulid>` (時系列ソート + 衝突防止)
 *
 * 既存の SK="META" 行を巻き込まないので /portal/me lookup と GSI2 に影響しない
 * (sparse な追加行)。TTL は親 deployment の `expiresAt` を継承し、event teardown
 * 時に一緒に消える。
 *
 * [Issue #2527 Slice 1 step 2] The domain fields (source / points / result docs
 * included) live on {@link ScoreEventRecord}
 * (`control-data/domain/deployments.ts`, the source of truth); this item only
 * adds the physical DynamoDB keys.
 */
export interface ScoreEventItem extends ScoreEventRecord {
  PK: string;
  SK: string;
}

/**
 * [Issue #2441 / Phase B3] Pure builder for the domain view of one score event
 * (no physical PK/SK — those are the `DeploymentsRepository.appendScoreEvent`
 * backend's concern). HealthCheck (uptime / attack-detected) and submit-flag
 * (flag) / reveal-hint (hint) / generic-scoring all build a record through this
 * before calling their own resolved `DeploymentsRepository.appendScoreEvent`.
 *
 * `parent` から jobId / teamId / eventId / expiresAt を継承して event row を組む。
 * `result` は source に応じて自動決定 (= attack-detected なら "down"、 flag-wrong なら "wrong"、
 * それ以外は "ok")。
 */
export function buildScoreEventRecord(
  parent: Pick<DeploymentItem, "jobId" | "problemId" | "teamId" | "eventId" | "expiresAt">,
  source: ScoreEventItem["source"],
  points: number,
  occurredAt: string,
): ScoreEventRecord {
  return {
    jobId: parent.jobId,
    problemId: parent.problemId,
    teamId: parent.teamId,
    eventId: parent.eventId,
    source,
    points,
    result: source === "attack-detected" ? "down" : source === "flag-wrong" ? "wrong" : "ok",
    occurredAt,
    expiresAt: Number(parent.expiresAt ?? 0),
  };
}

/**
 * ScoreEventItem (物理 PK/SK 付き) を組み立てる pure builder。 score 加算と event append を
 * 1 transaction で書く経路 (#2283 gate-bonus — 「score は加算されたのに履歴行が無い」 分裂を
 * 構造的に防ぐ、`DeploymentsRepository.awardGateBonusAtomic` の TransactWrite Put) が使う。
 * B3 以降の単発 append は {@link buildScoreEventRecord} + `appendScoreEvent` に移行済み
 * (SK の ulid はそちらでは backend が発番する)。
 */
export function buildScoreEventItem(
  parent: Pick<DeploymentItem, "jobId" | "problemId" | "teamId" | "eventId" | "expiresAt">,
  source: ScoreEventItem["source"],
  points: number,
  occurredAt: string,
): ScoreEventItem {
  const record = buildScoreEventRecord(parent, source, points, occurredAt);
  return {
    PK: `DEPLOYMENT#${parent.jobId}`,
    SK: `EVENT#${occurredAt}#${ulid()}`,
    ...record,
  };
}
