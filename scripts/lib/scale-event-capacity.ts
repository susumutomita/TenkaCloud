/**
 * [Issue #1667] Runtime-adjustable DynamoDB capacity — pure planner + guardrails.
 *
 * The `DynamoDbLowCapacity` aspect pins every table to 1 RCU / 1 WCU at deploy time (cost-zero
 * baseline). The capacity model (`scripts/capacity-model.ts`) shows that throttles at ~8 teams.
 * For a larger event the operator needs to raise capacity **without a redeploy** and return it
 * to 1/1 at teardown — exactly the "運用中に変更できるように" improvement the owner asked for.
 *
 * This module is the **pure plan + guardrail** layer (no AWS calls): it validates the target,
 * caps per-table units, and warns when the total leaves the 25/25 Free Tier (= will incur cost).
 * The actual `UpdateTable` lives in the CLI (`scripts/scale-event-capacity.ts`) behind an
 * injected client so this stays unit-testable. The aspect re-pins to 1/1 on the next deploy, so
 * a runtime raise is a deliberate, temporary, event-window override — not a permanent change.
 *
 * Scope: base-table provisioned throughput. GSI throughput (its own units) is a documented
 * follow-up — surfaced as a warning so the operator is not misled into thinking GSIs scaled.
 */

export interface CapacityTarget {
  readonly readCapacity: number;
  readonly writeCapacity: number;
}

export interface ScalePlanInput {
  readonly tables: readonly string[];
  readonly target: CapacityTarget;
  /** per-table の上限 unit (= 暴走防止のコストガードレール)。 */
  readonly maxUnitsPerTable: number;
}

export interface ScalePlanEntry {
  readonly table: string;
  readonly readCapacity: number;
  readonly writeCapacity: number;
}

export type ScalePlanResult =
  | {
      readonly ok: true;
      readonly entries: readonly ScalePlanEntry[];
      readonly warnings: readonly string[];
    }
  | { readonly ok: false; readonly errors: readonly string[] };

/** AWS Free Tier (per account, per axis)。 これを超えると課金される。 */
export const FREE_TIER_TOTAL_UNITS = 25;
/** per-table の既定上限 (= Free Tier 全枠を 1 table が食い尽くさないための安全弁)。 */
export const DEFAULT_MAX_UNITS_PER_TABLE = 25;
/** `DynamoDbLowCapacity` が強制する baseline (= teardown 時に戻す値)。 */
export const BASELINE_UNITS = 1;

/**
 * 目標 capacity を検証し、 table 別の UpdateTable 計画を返す。 不正値 (非正整数 / per-table 上限超過 /
 * table 未指定) は errors で reject。 合計が Free Tier を超える場合は warning (= 課金の明示) を付けて ok。
 */
export function planCapacityChange(input: ScalePlanInput): ScalePlanResult {
  const errors: string[] = [];
  const { readCapacity, writeCapacity } = input.target;

  for (const [label, value] of [
    ["readCapacity", readCapacity],
    ["writeCapacity", writeCapacity],
  ] as const) {
    if (!Number.isInteger(value) || value < BASELINE_UNITS) {
      errors.push(`${label} must be an integer >= ${BASELINE_UNITS} (got ${value})`);
    } else if (value > input.maxUnitsPerTable) {
      errors.push(
        `${label}=${value} exceeds the per-table cap ${input.maxUnitsPerTable} (cost guardrail; raise --max only deliberately)`,
      );
    }
  }
  if (input.tables.length === 0) errors.push("no tables specified");
  if (errors.length > 0) return { ok: false, errors };

  const warnings: string[] = [];
  const totalRead = readCapacity * input.tables.length;
  const totalWrite = writeCapacity * input.tables.length;
  if (totalRead > FREE_TIER_TOTAL_UNITS || totalWrite > FREE_TIER_TOTAL_UNITS) {
    warnings.push(
      `total provisioned ${totalRead} RCU / ${totalWrite} WCU across ${input.tables.length} table(s) ` +
        `exceeds the ${FREE_TIER_TOTAL_UNITS}/${FREE_TIER_TOTAL_UNITS} Free Tier — this WILL incur cost. ` +
        `Return to ${BASELINE_UNITS}/${BASELINE_UNITS} at teardown.`,
    );
  }
  if (readCapacity > BASELINE_UNITS || writeCapacity > BASELINE_UNITS) {
    warnings.push(
      "GSI throughput is NOT changed by this tool (GSIs have their own units); scale them separately if a hot read path uses a GSI.",
    );
  }

  const entries = input.tables.map((table) => ({ table, readCapacity, writeCapacity }));
  return { ok: true, entries, warnings };
}

/** UpdateTable 1 本ぶんの注入 I/O (= CLI が実 DynamoDB client を渡す、 test は fake)。 */
export interface CapacityApplyDeps {
  readonly updateTable: (
    table: string,
    readCapacity: number,
    writeCapacity: number,
  ) => Promise<void>;
}

/** 計画を順に適用する。 1 件失敗しても残りを試み、 適用できた table と失敗を返す (= 部分適用の可視化)。 */
export async function applyCapacityPlan(
  entries: readonly ScalePlanEntry[],
  deps: CapacityApplyDeps,
): Promise<{ readonly applied: string[]; readonly failed: { table: string; error: string }[] }> {
  const applied: string[] = [];
  const failed: { table: string; error: string }[] = [];
  for (const e of entries) {
    try {
      await deps.updateTable(e.table, e.readCapacity, e.writeCapacity);
      applied.push(e.table);
    } catch (err) {
      failed.push({ table: e.table, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { applied, failed };
}
