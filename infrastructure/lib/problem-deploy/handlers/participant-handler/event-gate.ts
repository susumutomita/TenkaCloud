import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { ParticipantSharedResources } from "./shared.js";

/**
 * Issue #1005 / Issue #13: event の scoring gate を participant routes 間で共有する。
 *
 * 旧来 submit-flag だけが gate を見ていたが、 hint reveal も同じ gate に従う必要がある
 * (= 開始前 / 終了後に hint を開封して penalty を accrue させない、 競技の公平性)。
 *
 * 本モジュールは:
 *   - `getEventGate(eventId)` で event 行から gate fields を 1 GetItem で取得
 *   - `evaluateGate(gate, now)` で fail-closed に 「採点経路を続けてよい」 か判定
 *
 * 採点経路を block するべき場合は kind + 補助情報を返す。 通せるなら `undefined`。
 * 旧 submit-flag に閉じていた gate を、 reveal-hint からも同関数で呼べる shape にする。
 */

export type GateBlock =
  | { kind: "scoring_not_started"; startsAt?: string }
  | { kind: "scoring_ended"; endsAt?: string }
  | { kind: "scoring_locked" };

export interface EventGate {
  readonly scoringLocked: boolean;
  readonly startsAt: string | undefined;
  readonly endsAt: string | undefined;
  readonly status: string | undefined;
  /**
   * Issue #1038 P1 #9 follow-up: scoreboard freeze window (= 終了 N 分前 〜 終了時刻まで順位を
   * 隠す) の分数。 0 (= freeze 無効)、 未設定 (= default 30 分)、 1〜180 の範囲を運用想定。
   * operator が `PATCH /events/:eventId/schedule` で更新できる。
   */
  readonly scoreboardFreezeMinutes: number | undefined;
}

/**
 * Event 行の gate fields (scoringLocked / startsAt / endsAt / status / scoreboardFreezeMinutes)
 * を 1 GetItem で取得。 不在 / DDB error は fail-closed (= undefined 返却、 evaluateGate 側で
 * scoring_not_started に変換) で安全側に倒す。
 */
export async function getEventGate(
  shared: ParticipantSharedResources,
  eventId: string,
): Promise<EventGate | undefined> {
  try {
    const out = await shared.ddb.send(
      new GetCommand({
        TableName: shared.eventsTableName,
        Key: { PK: `EVENT#${eventId}`, SK: "META" },
        ProjectionExpression: "scoringLocked, startsAt, endsAt, #s, scoreboardFreezeMinutes",
        ExpressionAttributeNames: { "#s": "status" },
      }),
    );
    const item = out.Item as
      | {
          scoringLocked?: boolean;
          startsAt?: string;
          endsAt?: string;
          status?: string;
          scoreboardFreezeMinutes?: number;
        }
      | undefined;
    if (!item) return undefined;
    return {
      scoringLocked: item.scoringLocked === true,
      startsAt: item.startsAt,
      endsAt: item.endsAt,
      status: item.status,
      scoreboardFreezeMinutes:
        typeof item.scoreboardFreezeMinutes === "number" ? item.scoreboardFreezeMinutes : undefined,
    };
  } catch (err) {
    console.warn("[event-gate] getEventGate failed", {
      eventId,
      message: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Gate 評価。 順序 (= 上から先に該当した kind を返す):
 *   1. gate 不在 (= event 行なし)        → scoring_not_started
 *   2. status=ENDED / ARCHIVED           → scoring_ended
 *   3. startsAt 未設定                   → scoring_not_started
 *   4. now < startsAt                    → scoring_not_started
 *   5. endsAt 設定 + now > endsAt        → scoring_ended
 *   6. scoringLocked                     → scoring_locked
 *   7. それ以外                          → undefined (= 採点可能)
 */
export function evaluateGate(gate: EventGate | undefined, nowMs: number): GateBlock | undefined {
  if (!gate) return { kind: "scoring_not_started" };
  if (gate.status === "ENDED" || gate.status === "ARCHIVED") {
    return { kind: "scoring_ended", endsAt: gate.endsAt };
  }
  if (!gate.startsAt) return { kind: "scoring_not_started" };
  const startMs = Date.parse(gate.startsAt);
  if (Number.isFinite(startMs) && nowMs < startMs) {
    return { kind: "scoring_not_started", startsAt: gate.startsAt };
  }
  if (gate.endsAt) {
    const endMs = Date.parse(gate.endsAt);
    if (Number.isFinite(endMs) && nowMs > endMs) {
      return { kind: "scoring_ended", endsAt: gate.endsAt };
    }
  }
  if (gate.scoringLocked) return { kind: "scoring_locked" };
  return undefined;
}
