/**
 * [Composite Runtime / Issue #2061] Composite parent + per-target deployment
 * row shapes and key helpers.
 *
 * A Composite problem persists:
 *   - one **parent** coordination row (runtimeKind=composite), and
 *   - N independent **target** rows, each a normal deployment row addressed by
 *     its own `targetDeploymentId` + the standard `META` sort key.
 *
 * Targets reuse the existing deployment row fields so the current AWS
 * EventBridge / Step Functions path and the non-AWS reconciler can keep
 * operating on a target solely by `DEPLOYMENT#{targetDeploymentId}` / `META`
 * (ADR-023 / epic #2058). Parent + target rows deliberately DO NOT populate
 * GSI1 (tenant list) or GSI2 (participant teamLoginKey) so they stay out of the
 * existing list / portal queries until a later issue adds an intentional view.
 * Target rows alone populate GSI3 for parent→target lookup.
 *
 * This module is storage shape only — no DynamoDB client, no execution.
 */

import type { DeploymentItem, DeploymentStatus } from "./types.js";

/** Marks a parent deployment row as the composite coordination record. */
export const COMPOSITE_RUNTIME_KIND = "composite" as const;

/** Schema version of the composite parent row, bumped on breaking shape changes. */
export const COMPOSITE_VERSION = 1 as const;

/** Inclusive bounds on the number of targets a composite problem may declare. */
export const MIN_COMPOSITE_TARGETS = 2;
export const MAX_COMPOSITE_TARGETS = 8;

/**
 * Composite parent row. A lightweight coordination record — it owns the
 * problem-level identity and target count, not a single provider's deploy
 * fields (those live on each target row). Shares the `DEPLOYMENT#{id}` / `META`
 * key convention with every other deployment row but carries no GSI keys.
 */
export interface CompositeParentDeploymentItem {
  PK: string;
  SK: "META";
  jobId: string;
  tenantId: string;
  problemId: string;
  runtimeKind: typeof COMPOSITE_RUNTIME_KIND;
  compositeVersion: number;
  targetCount: number;
  status: DeploymentStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
  /**
   * [#2063] Team identity shared with every target row. The parent carries them
   * so a reader can confirm the whole composite belongs to one team without
   * fanning out to the targets. Not GSI2-indexed (the parent stays out of the
   * participant teamLoginKey query until a later issue adds an intentional view).
   */
  teamName?: string;
  teamLoginKey?: string;
  /** Reserved bulk-deploy grouping fields copied from the validated request. */
  accountGroupId?: string;
  problemSetId?: string;
}

/**
 * Composite target row. A full deployment row (so existing execution paths can
 * drive it unchanged) plus parent linkage + the GSI3 lookup key. GSI1/GSI2 are
 * intentionally omitted so the target never surfaces in the tenant list or the
 * participant portal query.
 */
export type CompositeTargetDeploymentItem = Omit<
  DeploymentItem,
  "GSI1PK" | "GSI1SK" | "GSI2PK" | "GSI2SK"
> & {
  parentDeploymentId: string;
  targetId: string;
  targetOrdinal: number;
  runtimeProvider: string;
  runtimeEngine: string;
  runtimeEntry: string;
  GSI3PK: string;
  GSI3SK: string;
};

/** Base-table partition key for any deployment row (`DEPLOYMENT#{id}`). */
export function deploymentPk(deploymentId: string): string {
  return `DEPLOYMENT#${deploymentId}`;
}

/** GSI3 partition key — groups every target under its parent. */
export function compositeTargetGsi3Pk(parentDeploymentId: string): string {
  return `PARENT_DEPLOYMENT#${parentDeploymentId}`;
}

/**
 * GSI3 sort key — orders targets by their zero-padded ordinal so a parent query
 * returns targets in declared order. `targetId` keeps the key unique even if two
 * targets were mis-assigned the same ordinal.
 */
export function compositeTargetGsi3Sk(targetOrdinal: number, targetId: string): string {
  return `ORDINAL#${padOrdinal(targetOrdinal)}#TARGET#${targetId}`;
}

/** Two digits is enough for 0..7 (MAX_COMPOSITE_TARGETS); keeps lexical = numeric order. */
function padOrdinal(targetOrdinal: number): string {
  return String(targetOrdinal).padStart(2, "0");
}

/** True when a row is a composite parent coordination record. */
export function isCompositeParentItem(item: unknown): item is CompositeParentDeploymentItem {
  const row = item as { runtimeKind?: unknown; SK?: unknown } | undefined;
  return row?.runtimeKind === COMPOSITE_RUNTIME_KIND && row?.SK === "META";
}

/** True when a row is a composite target (it links back to a parent). */
export function isCompositeTargetItem(item: unknown): item is CompositeTargetDeploymentItem {
  const row = item as { parentDeploymentId?: unknown; SK?: unknown } | undefined;
  return typeof row?.parentDeploymentId === "string" && row?.SK === "META";
}
