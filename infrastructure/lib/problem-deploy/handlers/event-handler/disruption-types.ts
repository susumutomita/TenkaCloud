/**
 * Issue #888: Red Team Disruption Injection の API / store の共通 type 定義。
 */

import type { ProblemDisruptionEntry } from "../../../utils/discover-problems-catalog";

/** Fire API の request scope。 */
export type DisruptionFireScope = "team" | "all" | "random-n";

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

export interface DisruptionAuditRow {
  readonly auditId: string;
  readonly tenantId: string;
  readonly eventId: string;
  readonly problemId: string;
  readonly disruptionId: string;
  readonly firedBy: string;
  readonly firedAt: string;
  readonly scope: DisruptionFireScope;
  readonly targetTeamIds: readonly string[];
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly requestId: string;
  readonly expiresAt: number;
}

export interface DisruptionCatalogEntry extends ProblemDisruptionEntry {
  readonly problemId: string;
}
