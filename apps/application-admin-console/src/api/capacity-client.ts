import type { ApiClient } from "./client";

/**
 * Issue #2410 Slice 2: イベント中の DynamoDB キャパシティ監視 client。
 * Event API (= apiBaseUrl) の `GET /admin/capacity` (TenantAdmin のみ) を叩く。
 * 型は backend `handlers/event-handler/capacity.ts` の response と 1:1。
 */

export type CapacityTableRole =
  | "deployments"
  | "events"
  | "teams"
  | "problemEndpoints"
  | "disruptions";

export interface CapacityGsiSummary {
  readonly indexName: string;
  readonly provisionedRead: number;
  readonly provisionedWrite: number;
  readonly readThrottleEvents: number;
  readonly writeThrottleEvents: number;
}

export interface CapacityTableSummary {
  readonly role: CapacityTableRole;
  readonly tableName: string;
  readonly provisionedRead: number;
  readonly provisionedWrite: number;
  readonly gsis: readonly CapacityGsiSummary[];
  readonly consumedReadPerSecAvg: number;
  readonly consumedWritePerSecAvg: number;
  readonly consumedReadPerSecPeak: number;
  readonly consumedWritePerSecPeak: number;
  readonly readThrottleEvents: number;
  readonly writeThrottleEvents: number;
}

export interface CapacityOverview {
  readonly windowMinutes: number;
  readonly ceiling: number;
  readonly runbookDocumentName: string | null;
  readonly generatedAt: string;
  readonly tables: readonly CapacityTableSummary[];
}

export async function getCapacityOverview(
  client: ApiClient,
  windowMinutes?: number,
): Promise<CapacityOverview> {
  const qs = windowMinutes !== undefined ? `?windowMinutes=${windowMinutes}` : "";
  return client.get<CapacityOverview>(`/admin/capacity${qs}`);
}
