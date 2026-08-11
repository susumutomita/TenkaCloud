import { type ProgressionGateConfig, parseProgressionGate } from "../shared/progression-gate.js";
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
  /**
   * Issue #2283: Progression Gate 設定 (未設定 / 不正 shape = Gate 無し)。 challenge access
   * guard (`challenge-access.ts`) と `/portal/me` の progression view が使う。 enforcement は
   * per-tenant flag `challengePrerequisiteGate` が ON のときだけ効く (guard 側で判定)。
   */
  readonly progressionGate: ProgressionGateConfig | undefined;
}

/**
 * Event 行の gate fields (scoringLocked / startsAt / endsAt / status / scoreboardFreezeMinutes)
 * を repository seam の point read で取得。 不在 / DDB error は fail-closed (= undefined 返却、
 * evaluateGate 側で scoring_not_started に変換) で安全側に倒す。
 *
 * `tenantId` は競技者の deployment 行 (その team の tenant) から導出して渡す。
 * 競技者が参照する eventId は常に自 tenant の event なので `getEvent(tenantId, eventId)` は
 * 従来の tenant-agnostic Get と同じ event を返す。 tenant 不一致 (= 別 tenant の eventId、
 * 実運用では発生しない) は undefined に畳まれ、 本モジュールの fail-closed 契約に沿って
 * scoring_not_started に倒れる。 tenantId が導出不能な旧行は fail-closed で安全側。
 *
 * 旧実装は ProjectionExpression で gate fields のみ読んでいたが、 getEvent は全属性を読む。
 * 読む属性が増えるだけで挙動は不変 (1/1 PROVISIONED では RCU 増も非問題)。 default backend
 * (`CONTROL_DATA_BACKEND` 未設定 = `dynamodb`) では従来と byte 互換の GetCommand を
 * `shared.ddb` 経由で発火する。 participant Lambda は Teams table 配線を持たないため events
 * repository のみ構築する (getEvent は teamsTableName を必要としない)。
 */
export async function getEventGate(
  shared: ParticipantSharedResources,
  tenantId: string | undefined,
  eventId: string,
): Promise<EventGate | undefined> {
  // tenantId が導出できない (= identity を持つ live deployment 行が無い) 場合は fail-closed。
  if (!tenantId) return undefined;
  try {
    // [#2527 Slice 4] events repository は注入済み runtime 経由で解決する。 旧実装は
    // createEventsRepository を env 直読みで手組みし deps.sql を渡せなかったため、
    // turso backend では factory が毎回 throw → 本 catch の fail-closed により全問題が
    // 「競技開始前」に固定される live 障害を起こした (2026-07-21、 純 Turso Lite 環境)。
    const events = await shared.runtime.resolveEventsRepository({
      ddb: shared.ddb,
      eventsTableName: shared.eventsTableName,
    });
    const event = await events.getEvent(tenantId, eventId);
    if (!event) return undefined;
    return {
      scoringLocked: event.scoringLocked === true,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      status: event.status,
      scoreboardFreezeMinutes:
        typeof event.scoreboardFreezeMinutes === "number"
          ? event.scoreboardFreezeMinutes
          : undefined,
      progressionGate: parseProgressionGate(event.progressionGate),
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
  // fail-closed: 解析不能な startsAt (schema は z.string() しか掛けないので非 ISO が
  // 保存されうる) は「開始を検証できない」= scoring_not_started に倒す。旧コードは
  // `Number.isFinite(NaN) && ...` が false になり block を素通りして採点を許していた
  // (= 競技開始前 / 不正設定でも flag 加点が通る fail-open、本モジュールの fail-closed 契約違反)。
  if (!Number.isFinite(startMs) || nowMs < startMs) {
    return { kind: "scoring_not_started", startsAt: gate.startsAt };
  }
  if (gate.endsAt) {
    const endMs = Date.parse(gate.endsAt);
    // fail-closed: 解析不能な endsAt は「終了前であることを検証できない」= scoring_ended に倒す
    // (= 検証不能な window で採点を受け付けない)。
    if (!Number.isFinite(endMs) || nowMs > endMs) {
      return { kind: "scoring_ended", endsAt: gate.endsAt };
    }
  }
  if (gate.scoringLocked) return { kind: "scoring_locked" };
  return undefined;
}
