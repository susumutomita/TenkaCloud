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
   * - `hint`: 競技者がヒントを開封し penalty が deduct された (Issue #1038 P1 #8、 2026-05-18)。
   *   旧来 hint reveal は score を直 ADD するだけで score event 履歴に出ず、 「-30 pt なのに
   *   履歴 0 件」 表示の不整合になっていた。
   * - `gate-bonus`: Progression Gate (Issue #2283) の完了 bonus。 team override の
   *   `completionBonus` を Gate challenge 完了時に 1 度だけ加算した marker。
   */
  source: "uptime" | "flag" | "flag-wrong" | "attack-detected" | "hint" | "gate-bonus";
  /**
   * 加算ポイント。`uptime` = scoring.pointsPerSuccess、`flag` = scoring.points、
   * `flag-wrong` = -wrongAnswerPenalty (= 減点、 負数)、 `attack-detected` = 0 (= イベント marker のみ)、
   * `hint` = -hint.penalty (= 減点、 負数)、 `gate-bonus` = teamOverrides[].completionBonus (= 正数)。
   */
  points: number;
  /**
   * 結果。
   * - `ok`: `uptime` で全 endpoint OK or `flag` で正解 or `hint` 開封成功
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
 * submit-flag (flag) / reveal-hint (hint) / generic-scoring から呼ばれるので shared/ に置く。
 *
 * #745 / #1243 / #1244: 書き込み失敗は throw する。 旧来の caller は console.warn で握り潰して
 * いたが、 親 score 加算と event 履歴の不整合 (= 「-10 pt なのに履歴 0 件」 / 「+100 pt なのに
 * timeline 0 件」) の温床になり、 portal の表示矛盾を生んでいた。 silent data loss より
 * visible failure を優先 (= CloudWatch + retry に乗せる)。
 *
 * `parent` から jobId / teamId / eventId / expiresAt を継承して event row を組む。
 * `result` は source に応じて自動決定 (= attack-detected なら "down"、 flag-wrong なら "wrong"、
 * それ以外は "ok")。
 */
export async function writeScoreEvent(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  parent: Pick<DeploymentItem, "jobId" | "problemId" | "teamId" | "eventId" | "expiresAt">,
  source: ScoreEventItem["source"],
  points: number,
  occurredAt: string,
): Promise<void> {
  const item = buildScoreEventItem(parent, source, points, occurredAt);
  await ddb.send(new PutCommand({ TableName: tableName, Item: item }));
}

/**
 * ScoreEventItem を組み立てる pure builder。 単発 PutItem (`writeScoreEvent`) のほか、
 * score 加算と event append を 1 transaction で書く経路 (#2283 gate-bonus — 「score は
 * 加算されたのに履歴行が無い」 分裂を構造的に防ぐ) からも使う。
 */
export function buildScoreEventItem(
  parent: Pick<DeploymentItem, "jobId" | "problemId" | "teamId" | "eventId" | "expiresAt">,
  source: ScoreEventItem["source"],
  points: number,
  occurredAt: string,
): ScoreEventItem {
  return {
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
}
