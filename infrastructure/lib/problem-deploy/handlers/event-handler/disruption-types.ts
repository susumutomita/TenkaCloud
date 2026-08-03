/**
 * Issue #888: Red Team Disruption Injection の API / store の共通 type 定義。
 */

import type { DisruptionFireScope } from "../../control-data/domain/disruptions.js";

// [Issue #2527 Slice 1 step 2] The domain module owns these shapes; this handler
// re-exports them so existing importers keep their import path.
export type {
  DisruptionAuditRow,
  DisruptionFireScope,
} from "../../control-data/domain/disruptions.js";

/** Fire API の入力。 caller (handler) で zod / 手動 validate 済を渡す前提。 */
export interface DisruptionFireInput {
  readonly tenantId: string;
  readonly eventId: string;
  readonly problemId: string;
  readonly disruptionId: string;
  /** operatorEditable allow-list 通過後の parameters。 base parameters と merge 済。 */
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly scope: DisruptionFireScope;
  /** scope=team のみ意味を持つ。 他 scope では空配列。 */
  readonly targetTeamIds: readonly string[];
  /** scope=random-n のみ意味を持つ。 1 以上。 */
  readonly randomCount?: number;
  /** Client 生成の idempotency key。 */
  readonly requestId: string;
  /** Cognito sub。 audit log の firedBy に書く。 */
  readonly firedBy: string;
  /** 現在時刻 (ms)。 test で差し替え可能にする。 */
  readonly nowMs: number;
  /**
   * [ADR-037] scheduled fire の遅延分。 未指定 / 0 は即時注入 (= 従来)。 1 以上で
   * executor が `afterMinutes` 分後に注入を予約する (= published Detail に乗せて executor へ渡す)。
   */
  readonly afterMinutes?: number;
  /**
   * [ADR-037] recurring fire。 宣言されると executor が `rate(intervalMinutes)` schedule を作り、
   * maxFires 回ぶん経過後に aws-scheduler が自動停止する。 `afterMinutes` とは排他 (= schema で検証)。
   */
  readonly recurrence?: { readonly intervalMinutes: number; readonly maxFires: number };
}

export interface DisruptionFireResult {
  readonly auditId: string;
  readonly firedAt: string;
  readonly affectedTeamIds: readonly string[];
}

export type DisruptionFireOutcome =
  | { kind: "ok"; result: DisruptionFireResult }
  | { kind: "duplicate"; result: DisruptionFireResult }
  | { kind: "unknown_disruption" }
  | { kind: "unknown_problem" }
  | { kind: "invalid_parameters"; reason: string }
  | { kind: "invalid_scope"; reason: string }
  | { kind: "no_targets" };
