import { ulid } from "ulid";
import type {
  DeploymentsQueryPort,
  DeploymentsScoringPort,
} from "../../control-data/deployments-repository.js";
import type { DeploymentItem, DeploymentStatus } from "../deploy-handler/types.js";
import { DELETED_LIKE_STATUSES, ULID_RE } from "../shared/constants.js";
import {
  type ParticipantSharedResources,
  queryTeamItems,
  resolveDeploymentsRepository,
} from "./shared.js";

/**
 * 「Battle 中のイベント注入 + チーム間 interactive 交流」 の platform-side dispatch primitive。
 *
 * dispatch boundary:
 *   - inter-team interaction の semantics (= alliance / attack / shared queue / etc.) は
 *     問題ごとに異なるので、 platform に hardcode せず dispatch だけ提供する
 *   - 問題側 plugin が portal で polling して inbox を読み、 問題固有の UI / scoring に
 *     繋ぎ込む
 *
 * 通信モデル: SSE / WebSocket を使わず polling。Lambda
 * 運用 / 既存 portal の polling 周期 (30s) に乗せる。
 *
 * 物理: Deployments テーブル (= 既存) に `INBOX#<isoTs>#<ulid>` SK pattern を増やすだけ
 * なので CDK / IAM 変更不要。 PK は recipient deployment の `DEPLOYMENT#<jobId>`。
 * 7 日 TTL で自然消滅させる (= Issue #1200 と整合)。
 *
 * 注意 — 本 primitive は per-deployment 直接送信のみ。 以下は scope 外:
 *   - operator → competitor (= Issue #888 Phase B、 別件)
 *   - event broadcast (= 全 team 同報、 別件)
 *   - cross-account forward (= 競技者 AWS 内 Lambda が直接読む経路、 別件)
 */

const INBOX_SK_PREFIX = "INBOX#";
const INBOX_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_PAYLOAD_BYTES = 4 * 1024;
const KIND_RE = /^[a-z][a-z0-9-]{0,63}$/;

export interface InboxEvent {
  readonly eventId: string;
  readonly fromTeamId: string;
  readonly fromJobId: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly occurredAt: string;
}

export type CastEventOutcome =
  | { kind: "ok"; eventId: string; occurredAt: string }
  | { kind: "unauthorized" }
  | { kind: "invalid_jobid" }
  | { kind: "invalid_kind" }
  | { kind: "invalid_payload" }
  | { kind: "target_not_found" }
  | { kind: "cross_event_forbidden" }
  | { kind: "not_ready" };

export type InboxReadOutcome =
  | { kind: "ok"; events: readonly InboxEvent[] }
  | { kind: "unauthorized" }
  | { kind: "invalid_jobid" }
  | { kind: "invalid_since_ms" };

/** 受信側 inbox query の sinceMs 上限。 RCU 暴発防止 (= 24h 分以上は遡れない)。 */
export const INBOX_SINCE_MS_MAX = 24 * 60 * 60 * 1000;

interface CastEventInput {
  readonly targetJobId: string;
  readonly kind: string;
  readonly payload: unknown;
}

function isActiveDeployment(item: Partial<DeploymentItem>): boolean {
  const status = (item.status ?? "PENDING") as DeploymentStatus;
  if (DELETED_LIKE_STATUSES.has(status)) return false;
  // Issue #2019: APPROVAL_PENDING is held in-flight (no stack exists yet), so it
  // is not active — treat it like PENDING / IN_PROGRESS.
  if (status === "PENDING" || status === "APPROVAL_PENDING" || status === "IN_PROGRESS") {
    return false;
  }
  return true;
}

function toSenderContext(
  item: Partial<DeploymentItem>,
): { eventId: string; teamId: string; jobId: string } | undefined {
  if (typeof item.eventId !== "string") return undefined;
  if (typeof item.teamId !== "string") return undefined;
  if (typeof item.jobId !== "string") return undefined;
  return { eventId: item.eventId, teamId: item.teamId, jobId: item.jobId };
}

/**
 * sender team の所有 deployment 一覧から自分の「 active な代表行 」 を選び、
 * sender 同定情報 (eventId / teamId / jobId) を返す。 deleted / pending は不可。
 */
function pickSenderContext(
  items: readonly Partial<DeploymentItem>[],
): { eventId: string; teamId: string; jobId: string } | undefined {
  for (const item of items) {
    if (!isActiveDeployment(item)) continue;
    const ctx = toSenderContext(item);
    if (ctx) return ctx;
  }
  return undefined;
}

/**
 * Caller の所有 deployment 一覧から、 与えられた jobId 行を返す (= 認可済 lookup)。
 */
function findOwnedDeployment(
  items: readonly Partial<DeploymentItem>[],
  jobId: string,
): Partial<DeploymentItem> | undefined {
  return items.find((i) => i.jobId === jobId);
}

export function validateKind(raw: unknown): raw is string {
  return typeof raw === "string" && KIND_RE.test(raw);
}

export function validatePayload(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true;
  if (typeof raw !== "object") return false;
  try {
    const json = JSON.stringify(raw);
    return Buffer.byteLength(json, "utf8") <= MAX_PAYLOAD_BYTES;
  } catch {
    return false;
  }
}

/**
 * Team A → 指定 jobId に inbox event を 1 件追加する。
 *
 * 認可:
 *   - caller の teamLoginKey で deployment 群を引き、 active な代表行から `eventId` を取得
 *   - target jobId の deployment を別途 query して `eventId` を比較
 *   - 同 event 内であれば許可、 違うなら `cross_event_forbidden`
 *
 * 副作用: target deployment の PK の partition に `INBOX#<isoTs>#<ulid>` 行を Put。
 * TTL は 7 日 (= 自然消滅、 retention 議論 #1200 と整合)。
 */
export async function castEvent(
  shared: ParticipantSharedResources,
  teamLoginKey: string,
  input: CastEventInput,
): Promise<CastEventOutcome> {
  if (!ULID_RE.test(input.targetJobId)) return { kind: "invalid_jobid" };
  if (!validateKind(input.kind)) return { kind: "invalid_kind" };
  if (!validatePayload(input.payload)) return { kind: "invalid_payload" };

  const myItems = await queryTeamItems(shared, teamLoginKey);
  if (myItems.length === 0) return { kind: "unauthorized" };
  const sender = pickSenderContext(myItems);
  if (!sender) return { kind: "not_ready" };

  const deploymentsRepository: DeploymentsQueryPort & DeploymentsScoringPort =
    await resolveDeploymentsRepository(shared);
  const target = (await deploymentsRepository.queryDeploymentMeta(input.targetJobId)) as
    | Partial<DeploymentItem>
    | undefined;
  if (!target) return { kind: "target_not_found" };
  const targetStatus = (target.status ?? "PENDING") as DeploymentStatus;
  if (DELETED_LIKE_STATUSES.has(targetStatus)) return { kind: "target_not_found" };
  const targetEventId = typeof target.eventId === "string" ? target.eventId : undefined;
  if (!targetEventId) return { kind: "target_not_found" };
  if (targetEventId !== sender.eventId) return { kind: "cross_event_forbidden" };

  const occurredAt = new Date().toISOString();
  const inboxId = ulid();
  const ttl = Math.floor(Date.now() / 1000) + INBOX_TTL_SECONDS;
  // [Issue #2441 / Phase B3] `appendInboxEvent` derives the physical
  // `INBOX#<occurredAt>#<inboxId>` SK; `inboxId` is generated here (not by the
  // backend) because it also becomes the domain-visible `CastEventOutcome.eventId`.
  await deploymentsRepository.appendInboxEvent(input.targetJobId, inboxId, {
    eventId: sender.eventId,
    fromTeamId: sender.teamId,
    fromJobId: sender.jobId,
    kind: input.kind,
    payload: input.payload ?? {},
    occurredAt,
    ttl,
  });
  return { kind: "ok", eventId: inboxId, occurredAt };
}

function isValidSinceMs(sinceMs: number, nowMs: number): boolean {
  if (!Number.isInteger(sinceMs)) return false;
  if (sinceMs < 0) return false;
  if (sinceMs > nowMs) return false;
  if (nowMs - sinceMs > INBOX_SINCE_MS_MAX) return false;
  return true;
}

function toInboxEvent(item: Record<string, unknown>): InboxEvent | undefined {
  const eventId = typeof item.eventId === "string" ? item.eventId : "";
  const fromTeamId = typeof item.fromTeamId === "string" ? item.fromTeamId : "";
  const fromJobId = typeof item.fromJobId === "string" ? item.fromJobId : "";
  const kind = typeof item.kind === "string" ? item.kind : "";
  const occurredAt = typeof item.occurredAt === "string" ? item.occurredAt : "";
  if (!eventId || !fromTeamId || !fromJobId || !kind || !occurredAt) return undefined;
  return { eventId, fromTeamId, fromJobId, kind, payload: item.payload, occurredAt };
}

async function queryInboxRows(
  shared: ParticipantSharedResources,
  jobId: string,
  sinceMs: number,
): Promise<readonly Record<string, unknown>[]> {
  const sinceIso = new Date(sinceMs).toISOString();
  const skStart = `${INBOX_SK_PREFIX}${sinceIso}`;
  const skEnd = `${INBOX_SK_PREFIX}~`;
  const deploymentsRepository: DeploymentsQueryPort & DeploymentsScoringPort =
    await resolveDeploymentsRepository(shared);
  return [...(await deploymentsRepository.listInboxEventsInRange(jobId, skStart, skEnd))] as Record<
    string,
    unknown
  >[];
}

/**
 * 自分の指定 jobId の inbox から、 `sinceMs` (epoch ms) 以降の event を時系列降順で返す。
 * 認可は teamLoginKey + jobId 所有チェック。
 */
export async function readInbox(
  shared: ParticipantSharedResources,
  teamLoginKey: string,
  jobIdRaw: string,
  sinceMsRaw: number,
  nowMs: number = Date.now(),
): Promise<InboxReadOutcome> {
  if (!ULID_RE.test(jobIdRaw)) return { kind: "invalid_jobid" };
  if (!isValidSinceMs(sinceMsRaw, nowMs)) return { kind: "invalid_since_ms" };

  const myItems = await queryTeamItems(shared, teamLoginKey);
  if (myItems.length === 0) return { kind: "unauthorized" };
  if (!findOwnedDeployment(myItems, jobIdRaw)) return { kind: "unauthorized" };

  const rows = await queryInboxRows(shared, jobIdRaw, sinceMsRaw);
  const events: InboxEvent[] = [];
  for (const row of rows) {
    const ev = toInboxEvent(row);
    if (ev) events.push(ev);
  }
  return { kind: "ok", events };
}
