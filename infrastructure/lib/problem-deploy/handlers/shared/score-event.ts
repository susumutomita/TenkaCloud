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

/**
 * [#2866] 公開 score-event view — operator (event-handler `team-score-events`) と
 * participant (participant-handler `leaderboard-score-events`) の両 endpoint が返す
 * 1 event の公開 shape。 両 handler が同一の ALLOWED_SOURCES / toView を持っていて
 * ドリフト事故 (#2283: gate-bonus を片側だけ除外すると operator 画面と leaderboard の
 * 合計がズレる) の温床だったため、 値集合と mapping をここに 1 本化した。
 *
 * 公開 source は 5 種のみ: scoring に影響する uptime / flag / flag-wrong / hint /
 * gate-bonus。 marker 用 `attack-detected` (= result=down) は累計 score に影響しない
 * ので通さない (= chart に並べない)。
 */
export const PUBLIC_SCORE_EVENT_SOURCES = [
  "uptime",
  "flag",
  "flag-wrong",
  "hint",
  "gate-bonus",
] as const;
export const PUBLIC_SCORE_EVENT_RESULTS = ["ok", "wrong"] as const;

export interface PublicScoreEventView {
  readonly jobId: string;
  readonly problemId: string;
  readonly source: (typeof PUBLIC_SCORE_EVENT_SOURCES)[number];
  readonly points: number;
  readonly result: (typeof PUBLIC_SCORE_EVENT_RESULTS)[number];
  readonly occurredAt: string;
}

const PUBLIC_SOURCE_SET = new Set<string>(PUBLIC_SCORE_EVENT_SOURCES);
const PUBLIC_RESULT_SET = new Set<string>(PUBLIC_SCORE_EVENT_RESULTS);

/**
 * ScoreEventItem (DDB row) → {@link PublicScoreEventView}。 許可外 source / result や
 * 欠損 field の row は undefined (= 公開しない)。 内部 field (teamLoginKey / tenantId /
 * awsAccountId / expiresAt / PK / SK) は公開 shape に存在しないので構造的に漏洩しない。
 */
export function toPublicScoreEventView(
  item: Partial<ScoreEventItem>,
): PublicScoreEventView | undefined {
  if (typeof item.jobId !== "string") return undefined;
  if (typeof item.problemId !== "string") return undefined;
  if (typeof item.source !== "string") return undefined;
  if (!PUBLIC_SOURCE_SET.has(item.source)) return undefined;
  if (typeof item.result !== "string") return undefined;
  if (!PUBLIC_RESULT_SET.has(item.result)) return undefined;
  if (typeof item.occurredAt !== "string") return undefined;
  return {
    jobId: item.jobId,
    problemId: item.problemId,
    source: item.source as PublicScoreEventView["source"],
    points: Number(item.points ?? 0),
    result: item.result as PublicScoreEventView["result"],
    occurredAt: item.occurredAt,
  };
}
