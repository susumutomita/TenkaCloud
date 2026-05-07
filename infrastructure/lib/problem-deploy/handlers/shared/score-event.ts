import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import type { DeploymentItem } from "../deploy-handler/types.js";

/**
 * 1 採点イベント (= スコア加算の単位) を Deployments table に書き込むときの shape。
 *
 *   PK = `DEPLOYMENT#<jobId>` (= 親 deployment と同じ partition)
 *   SK = `EVENT#<isoTimestamp>#<ulid>` (時系列ソート + 衝突防止)
 *
 * 既存の SK="META" 行を巻き込まないので /portal/me lookup と GSI2 に影響しない
 * (sparse な追加行)。TTL は親 deployment の `expiresAt` を継承し、event teardown
 * 時に一緒に消える。
 */
export interface ScoreEventItem {
  PK: string;
  SK: string;

  jobId: string;
  problemId: string;
  /** Phase 2a 以前の旧 deployment は持たない (= history 列も undefined)。 */
  teamId?: string;
  eventId?: string;
  /** 加点の発生源。`uptime` = HealthCheck の probe 成功、`flag` = 競技者の flag 提出。 */
  source: "uptime" | "flag";
  /** 加算ポイント。flag は scoring.points、uptime は scoring.pointsPerSuccess。 */
  points: number;
  /**
   * 結果。`uptime` で全 endpoint OK or `flag` で正解なら "ok"。
   * 失敗イベントは現状書き込まない (= history は加点ログのみ)。将来 fail も書くなら
   * extend 可能。
   */
  result: "ok";
  occurredAt: string;
  /** 親 deployment の TTL を継承。0 なら無期限 (旧 deployment 互換)。 */
  expiresAt: number;
}

/**
 * 採点イベントを 1 行 PutItem する。HealthCheck (uptime) と submit-flag (flag) の両方
 * から呼ばれるので shared/ に置く。書き込み失敗は親 score 加算と整合性が崩れるが、
 * caller が catch して log のみ残す方針 (= MVP は best-effort)。
 *
 * `parent` から jobId / teamId / eventId / expiresAt を継承して event row を組む。
 */
export async function writeScoreEvent(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  parent: Pick<DeploymentItem, "jobId" | "problemId" | "teamId" | "eventId" | "expiresAt">,
  source: ScoreEventItem["source"],
  points: number,
  occurredAt: string,
): Promise<void> {
  const item: ScoreEventItem = {
    PK: `DEPLOYMENT#${parent.jobId}`,
    SK: `EVENT#${occurredAt}#${ulid()}`,
    jobId: parent.jobId,
    problemId: parent.problemId,
    teamId: parent.teamId,
    eventId: parent.eventId,
    source,
    points,
    result: "ok",
    occurredAt,
    expiresAt: Number(parent.expiresAt ?? 0),
  };
  await ddb.send(new PutCommand({ TableName: tableName, Item: item }));
}
