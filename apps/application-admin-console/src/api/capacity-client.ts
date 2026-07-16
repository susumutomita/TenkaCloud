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
  /** false when this deployment uses no DynamoDB control-data tables. */
  readonly applicable: boolean;
  readonly reason?: "dynamodb_not_in_use";
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

/**
 * Issue #2680: `POST /admin/capacity` — Slice 1 の SSM runbook を admin console から起動して
 * 1 テーブルの RCU/WCU を変更する。型は backend `handlers/event-handler/capacity.ts` /
 * `routes/capacity.ts` の request/response と 1:1。
 */
export interface CapacityScaleRequest {
  readonly tableName: string;
  readonly readCapacityUnits: number;
  readonly writeCapacityUnits: number;
}

export interface CapacityScaleAccepted {
  readonly executionId: string;
  readonly tableName: string;
  readonly role: CapacityTableRole;
  readonly readCapacityUnits: number;
  readonly writeCapacityUnits: number;
  readonly status: "accepted";
}

export async function startCapacityScale(
  client: ApiClient,
  req: CapacityScaleRequest,
): Promise<CapacityScaleAccepted> {
  return client.post<CapacityScaleAccepted>("/admin/capacity", req);
}
