import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { DeploymentItem } from "../deploy-handler/types.js";
import { ULID_RE } from "../shared/constants.js";
import type { ScoreEventItem } from "../shared/score-event.js";
import { type ParticipantSharedResources, queryTeamItems } from "./shared.js";

/**
 * `GET /portal/me/battle-attacks?jobId=&sinceMin=` の response shape (ADR-005 D2)。
 *
 * Battle Portal の Attack Statistics / Attack History タブが poll する。`recoveredAt` は
 * その attack-detected event の **後で** 観測された最初の `uptime` event (= 復旧 marker)
 * の occurredAt を server-side で結合して返す。未復旧なら null。
 */
export interface BattleAttackEventView {
  readonly occurredAt: string;
  readonly source: "attack-detected";
  readonly result: "down";
  readonly recoveredAt: string | null;
}

export interface BattleAttacksResponse {
  readonly jobId: string;
  readonly problemId: string;
  readonly sinceMin: number;
  readonly events: readonly BattleAttackEventView[];
}

export type BattleAttacksOutcome =
  | { kind: "ok"; response: BattleAttacksResponse }
  | { kind: "unauthorized" }
  | { kind: "not_found" }
  | { kind: "invalid_jobid" }
  | { kind: "invalid_sincemin" };

/** sinceMin の上限。ADR-005 D2 で RCU 暴発防止のため設定。 */
export const BATTLE_ATTACKS_SINCE_MIN_MAX = 60;
/** sinceMin 既定値。明示的にクエリパラメータが無い場合に使う。 */
export const BATTLE_ATTACKS_SINCE_MIN_DEFAULT = 30;

/**
 * 自 team の指定 jobId の deployment について、直近 sinceMin 分内に観測された
 * attack-detected event を時系列降順で返す。recoveredAt は同 jobId の uptime event
 * (= 復旧 tick) を結合して計算する。
 *
 * 認可: teamLoginKey で team の deployment 一覧を取得し、jobId が含まれることを check
 * (= 自 team の deployment かを保証)。
 *
 * 設計: per-endpoint 情報は **絶対に出さない** (ADR-005 D1)。response の view shape
 * から構造的に漏れない (= occurredAt / source / result / recoveredAt のみ)。
 */
export async function listBattleAttacks(
  shared: ParticipantSharedResources,
  teamLoginKey: string,
  jobIdRaw: string,
  sinceMinRaw: number,
  nowMs: number = Date.now(),
): Promise<BattleAttacksOutcome> {
  if (!ULID_RE.test(jobIdRaw)) return { kind: "invalid_jobid" };
  if (
    !Number.isInteger(sinceMinRaw) ||
    sinceMinRaw < 1 ||
    sinceMinRaw > BATTLE_ATTACKS_SINCE_MIN_MAX
  ) {
    return { kind: "invalid_sincemin" };
  }

  const myItems = await queryTeamItems(shared, teamLoginKey);
  if (myItems.length === 0) return { kind: "unauthorized" };

  const target = myItems.find((i) => i.jobId === jobIdRaw) as
    | Pick<DeploymentItem, "PK" | "jobId" | "problemId">
    | undefined;
  if (!target || typeof target.PK !== "string") return { kind: "not_found" };

  const sinceIso = new Date(nowMs - sinceMinRaw * 60_000).toISOString();
  const out = await shared.ddb.send(
    new QueryCommand({
      TableName: shared.tableName,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :evpfx)",
      // FilterExpression は server 側で時間絞り込みする。GSI を新設せずに済ませる。
      FilterExpression: "occurredAt >= :since",
      ExpressionAttributeValues: {
        ":pk": target.PK,
        ":evpfx": "EVENT#",
        ":since": sinceIso,
      },
      // 降順で取り出して time-window 内のみ抽出。typical row 数は 100 以下を想定 (ADR-005)。
      ScanIndexForward: false,
    }),
  );

  const events = ((out.Items ?? []) as Partial<ScoreEventItem>[]).filter(
    (i): i is Partial<ScoreEventItem> => typeof i.source === "string",
  );

  // attack-detected と uptime を分けて、attack-detected の各行に recoveredAt を結合する。
  const attacks = events.filter((e) => e.source === "attack-detected");
  const recoveries = events
    .filter((e) => e.source === "uptime")
    .map((e) => String(e.occurredAt ?? ""))
    .filter((t) => t.length > 0)
    .sort(); // ascending order for binary-search-style "next after"

  const view: BattleAttackEventView[] = attacks
    .map((e) => {
      const occurredAt = String(e.occurredAt ?? "");
      if (!occurredAt) return undefined;
      // この attack より後で最初に観測された uptime event の occurredAt が recoveredAt。
      const recoveredAt = recoveries.find((t) => t > occurredAt) ?? null;
      return {
        occurredAt,
        source: "attack-detected" as const,
        result: "down" as const,
        recoveredAt,
      };
    })
    .filter((v): v is BattleAttackEventView => v !== undefined)
    .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0));

  return {
    kind: "ok",
    response: {
      jobId: target.jobId ?? jobIdRaw,
      problemId: String(target.problemId ?? ""),
      sinceMin: sinceMinRaw,
      events: view,
    },
  };
}
