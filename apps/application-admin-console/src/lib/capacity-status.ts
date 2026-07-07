import type { CapacityOverview, CapacityTableSummary } from "../api/capacity-client";

/**
 * Issue #2410 Slice 2: キャパ監視 panel の pure な判定 / 整形ロジック。
 * (コンポーネントから分離して単体テスト可能にする。)
 */

/** peak 消費がプロビジョンの何割で「hot (= 上げ時の兆候)」と見なすか。 */
export const HOT_UTILIZATION_THRESHOLD = 0.8;

/**
 * テーブル 1 行の健全性。
 *  - throttling: 直近 window で throttle が実際に出た (base or GSI) — 今すぐ上げる
 *  - hot:        throttle は無いが peak 消費が provisioned の 80% 以上 — 上げる準備
 *  - ok:         余裕あり
 */
export type CapacityHealth = "throttling" | "hot" | "ok";

/** base + 全 GSI の throttle 件数合計 (UI は「throttle が出たか」を 1 数字で見る)。 */
export function totalThrottleEvents(table: CapacityTableSummary): number {
  return (
    table.readThrottleEvents +
    table.writeThrottleEvents +
    table.gsis.reduce((acc, gsi) => acc + gsi.readThrottleEvents + gsi.writeThrottleEvents, 0)
  );
}

/** peak 消費 / provisioned の利用率 (0..1+)。provisioned が 0 (理論上ない) は 0 扱い。 */
export function peakUtilization(consumedPerSecPeak: number, provisioned: number): number {
  if (provisioned <= 0) return 0;
  return consumedPerSecPeak / provisioned;
}

export function classifyTable(table: CapacityTableSummary): CapacityHealth {
  if (totalThrottleEvents(table) > 0) return "throttling";
  const readHot = peakUtilization(table.consumedReadPerSecPeak, table.provisionedRead);
  const writeHot = peakUtilization(table.consumedWritePerSecPeak, table.provisionedWrite);
  if (readHot >= HOT_UTILIZATION_THRESHOLD || writeHot >= HOT_UTILIZATION_THRESHOLD) return "hot";
  return "ok";
}

export interface CapacityRowModel {
  readonly role: CapacityTableSummary["role"];
  readonly tableName: string;
  readonly health: CapacityHealth;
  /** "R/W" 表記のプロビジョン (例: "1 / 1")。 */
  readonly provisionedLabel: string;
  /** "avg → peak" 表記の消費 RCU/sec (例: "0.2 → 1.4")。 */
  readonly consumedReadLabel: string;
  readonly consumedWriteLabel: string;
  readonly throttleEvents: number;
}

export function buildCapacityRows(overview: CapacityOverview): readonly CapacityRowModel[] {
  return overview.tables.map((table) => ({
    role: table.role,
    tableName: table.tableName,
    health: classifyTable(table),
    provisionedLabel: `${table.provisionedRead} / ${table.provisionedWrite}`,
    consumedReadLabel: `${table.consumedReadPerSecAvg} → ${table.consumedReadPerSecPeak}`,
    consumedWriteLabel: `${table.consumedWritePerSecAvg} → ${table.consumedWritePerSecPeak}`,
    throttleEvents: totalThrottleEvents(table),
  }));
}

/**
 * runbook 実行コマンド例 (panel の footer にそのまま表示する)。上げ幅は運営が
 * `docs/operations/dynamodb-event-capacity.md` の目安表から選ぶ。
 */
export function buildRunbookCommand(documentName: string, tableName: string): string {
  return [
    "aws ssm start-automation-execution",
    `--document-name ${documentName}`,
    `--parameters TableName=${tableName},ReadCapacityUnits=<RCU>,WriteCapacityUnits=<WCU>`,
  ].join(" \\\n  ");
}
