import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
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
 */
export interface ScoreEventItem {
  PK: string;
  SK: string;

  jobId: string;
  problemId: string;
  /** Phase 2a 以前の旧 deployment は持たない (= history 列も undefined)。 */
  teamId?: string;
  eventId?: string;
  /**
   * イベント発生源。
   * - `uptime`: HealthCheck の probe で全 endpoint OK
   * - `flag`: 競技者の flag 提出が正解
   * - `flag-wrong`: 競技者の flag 提出が不正解で wrongAnswerPenalty が減点された (Issue #817)
   * - `attack-detected`: HealthCheck で `lastResult: ok → fail` 遷移を検知 (ADR-005 D2-A、
   *   Battle Portal の Attack Statistics / History で使う)
   */
  source: "uptime" | "flag" | "flag-wrong" | "attack-detected";
  /**
   * 加算ポイント。`uptime` = scoring.pointsPerSuccess、`flag` = scoring.points、
   * `flag-wrong` = -wrongAnswerPenalty (= 減点、 負数)、 `attack-detected` = 0 (= イベント marker のみ)。
   */
  points: number;
  /**
   * 結果。
   * - `ok`: `uptime` で全 endpoint OK or `flag` で正解
   * - `wrong`: `flag-wrong` (= 不正解で減点、 Issue #817)
   * - `down`: `attack-detected` (= 攻撃が刺さって uptime が落ちた)
   *
   * Phase 2 以前の event 行は `"ok"` のみ書かれているので backward compatible。
   */
  result: "ok" | "wrong" | "down";
  occurredAt: string;
  /** 親 deployment の TTL を継承。0 なら無期限 (旧 deployment 互換)。 */
  expiresAt: number;
}

/**
 * 採点イベントを 1 行 PutItem する。HealthCheck (uptime / attack-detected) と
 * submit-flag (flag) から呼ばれるので shared/ に置く。書き込み失敗は親 score 加算と
 * 整合性が崩れるが、caller が catch して log のみ残す方針 (= MVP は best-effort)。
 *
 * `parent` から jobId / teamId / eventId / expiresAt を継承して event row を組む。
 * `result` は source に応じて自動決定 (= attack-detected なら "down"、それ以外は "ok")。
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
    result: source === "attack-detected" ? "down" : source === "flag-wrong" ? "wrong" : "ok",
    occurredAt,
    expiresAt: Number(parent.expiresAt ?? 0),
  };
  await ddb.send(new PutCommand({ TableName: tableName, Item: item }));
}
