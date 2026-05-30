import type { EventStatus } from "../api/events-client";

/**
 * Issue #1330: 表示用の「effective status」 = raw `event.status` を時刻ベースで補正した値。
 *
 * 背景 (Phase indicator との乖離問題):
 *   - DB 上の `event.status` は手動遷移 (= 運営者が「競技開始」 / 「Event を終了」 button で明示変更)。
 *   - 一方 Phase indicator (= EventWizardPanel) は startsAt / endsAt / 現在時刻から動的計算するため、
 *     startsAt を過ぎた瞬間に「競技中」 表示になる。
 *   - 結果、 startsAt 過ぎ + status=READY のときに badge=「READY」 / Phase=「競技中」 で乖離。
 *
 * 解決方針 (Option A):
 *   表示時にのみ effective status を計算 (DB の status field 自体は不変)。 これで Phase と
 *   badge が常に同期する。 ENDED / TEARDOWN / ARCHIVED 等の terminal status は時刻無関係。
 *
 * 注意:
 *   - terminal status (ARCHIVED / TEARDOWN / ENDED) は時刻に関係なく raw status を返す
 *     (= 運営者が明示的に終了させた状態は時刻で巻き戻さない)。
 *   - DEPLOYING は wizard step に渡るので effective status としてもそのまま透過する。
 *   - DRAFT は startsAt が未来でも RUNNING にしない (= deploy 前提の workflow)。
 */
export type EffectiveStatus =
  | "DRAFT"
  | "DEPLOYING"
  | "READY"
  | "RUNNING"
  | "ENDED"
  | "TEARDOWN"
  | "ARCHIVED";

export interface EffectiveEventInput {
  readonly status: EventStatus;
  readonly startsAt?: string | null;
  readonly endsAt?: string | null;
}

/**
 * raw status + startsAt + endsAt + now から effective status を計算する純粋関数。
 *
 * 優先順位:
 *   1. terminal status (ARCHIVED / TEARDOWN / ENDED) は時刻無視で raw 返却
 *   2. DRAFT / DEPLOYING も時刻無視で raw 返却 (= deploy 前後では時刻に意味がない)
 *   3. それ以外 (= READY) で endsAt 過ぎ → ENDED に昇格
 *   4. startsAt 過ぎ (かつ endsAt 未到達) → RUNNING に昇格
 *   5. どれにも当てはまらなければ raw status (= READY) を返す
 */
export function computeEffectiveStatus(
  event: EffectiveEventInput,
  now: Date = new Date(),
): EffectiveStatus {
  // 1. terminal status は時刻無関係 (= 運営者が明示的に倒した状態を尊重)
  if (isTerminalEventStatus(event.status)) {
    return event.status;
  }
  // 2. deploy 前後の status は時刻に意味がない (= 競技開始時刻を過ぎていても deploy 未完了は RUNNING ではない)
  if (event.status === "DRAFT" || event.status === "DEPLOYING") {
    return event.status;
  }

  const start = event.startsAt ? new Date(event.startsAt) : null;
  const end = event.endsAt ? new Date(event.endsAt) : null;

  // 3. endsAt 過ぎ → ENDED に昇格 (= 終了時刻予約が満了した READY)
  if (end && now.getTime() >= end.getTime()) return "ENDED";

  // 4. startsAt 過ぎ → RUNNING (= 競技中)
  if (start && now.getTime() >= start.getTime()) return "RUNNING";

  // 5. それ以外 (= READY + startsAt 未来 or startsAt なし)
  return event.status;
}

/**
 * これ以上 deploy / 編集できない終端 status (= 運営者が明示終了させた状態) かを判定する。
 * `status === "ENDED" || "TEARDOWN" || "ARCHIVED"` が EventHeaderActions (×3) / OperationsTab /
 * scoringBadge / computeEffectiveStatus に 6 箇所コピペされていたのを集約する。
 * (EventPhaseBanner は raw status ではなく EffectiveStatus = RUNNING を含む別ドメインなので対象外。)
 */
const TERMINAL_EVENT_STATUSES: ReadonlySet<EventStatus> = new Set<EventStatus>([
  "ENDED",
  "TEARDOWN",
  "ARCHIVED",
]);

export function isTerminalEventStatus(status: EventStatus): boolean {
  return TERMINAL_EVENT_STATUSES.has(status);
}
