import { toErrorMessage, usePolling } from "@tenkacloud/web-kit";
import { StatusCodes } from "http-status-codes";
import { useCallback, useState } from "react";
import {
  AdminInsightApiError,
  fetchPipelineExecutions,
  fetchStateMachineExecutions,
  type PipelineExecutionItem,
  type StateMachineExecutionItem,
} from "../api/admin-drill-down";
import { type ApiClient, useApiClient } from "../api/client";
import {
  fetchTenantsInsightSummary,
  indexSummaryByTenantId,
  type TenantInsightSummary,
} from "../api/insight";
import { listTenants, type Tenant } from "../api/tenants";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";
import { ADMIN_POLL_INTERVAL_MS } from "../constants/polling";

/**
 * Issue #1770: Operations page のデータ取得 + polling + error 分類を 1 hook に閉じ込めた。
 *
 * 取得元 (既存 API のみ):
 *   - Control Plane API `GET /tenants` (= tenant count / active tenants)
 *   - AdminInsight API `GET /admin/insight/tenants/summary` (= active / failed deploy count)
 *   - AdminInsight jobs API (= recent provisioning / deprovisioning failures)
 *
 * SSE/WebSocket は使わず `usePolling` の 60 秒 polling に統一する。 OperationsPage 側は返り値
 * (snapshot + error フラグ + refresh) を組み立てるだけの thin orchestrator になる。
 */
const RECENT_FAILURE_FETCH_LIMIT = 20;
const RECENT_FAILURE_DISPLAY_LIMIT = 10;

export interface OperationsSnapshot {
  readonly tenants: readonly Tenant[];
  readonly insight: Readonly<Record<string, TenantInsightSummary>> | null;
  readonly recentFailures: readonly RecentFailure[];
  readonly insightUnavailable: boolean;
}

export interface RecentFailure {
  readonly rowId: string;
  readonly id: string;
  readonly kind: "provisioning" | "deprovisioning";
  readonly status: string;
  readonly startTimeIso: string | undefined;
  readonly lastUpdateTimeIso: string | undefined;
  readonly consoleUrl: string;
}

const FAILED_PIPELINE_STATUSES = new Set(["Failed"]);
const FAILED_STATE_MACHINE_STATUSES = new Set(["FAILED", "TIMED_OUT", "ABORTED"]);

function failureTimestamp(failure: RecentFailure): number {
  const parsed = Date.parse(failure.lastUpdateTimeIso ?? failure.startTimeIso ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function buildRecentFailures(
  pipelineItems: readonly PipelineExecutionItem[],
  stateMachineItems: readonly StateMachineExecutionItem[],
): readonly RecentFailure[] {
  const provisioning = pipelineItems
    .filter((item) => FAILED_PIPELINE_STATUSES.has(item.status))
    .map((item) => ({
      rowId: `provisioning:${item.executionId}`,
      id: item.executionId,
      kind: "provisioning" as const,
      status: item.status,
      startTimeIso: item.startTimeIso,
      lastUpdateTimeIso: item.lastUpdateTimeIso,
      consoleUrl: item.consoleUrl,
    }));
  const deprovisioning = stateMachineItems
    .filter((item) => FAILED_STATE_MACHINE_STATUSES.has(item.status))
    .map((item) => ({
      rowId: `deprovisioning:${item.executionArn}`,
      id: item.name,
      kind: "deprovisioning" as const,
      status: item.status,
      startTimeIso: item.startTimeIso,
      lastUpdateTimeIso: item.stopTimeIso,
      consoleUrl: item.consoleUrl,
    }));
  return [...provisioning, ...deprovisioning]
    .sort((a, b) => failureTimestamp(b) - failureTimestamp(a))
    .slice(0, RECENT_FAILURE_DISPLAY_LIMIT);
}

async function fetchOperationsSnapshot(
  config: AppConfig,
  idToken: string,
  api: ApiClient,
): Promise<OperationsSnapshot> {
  const tenants = await listTenants(api);
  if (!config.adminInsightApiUrl) {
    return {
      tenants,
      insight: null,
      recentFailures: [],
      insightUnavailable: true,
    };
  }

  const [summary, pipeline, stateMachine] = await Promise.all([
    fetchTenantsInsightSummary(
      config,
      idToken,
      tenants.map((tenant) => tenant.tenantId),
    ),
    fetchPipelineExecutions(config, idToken, { limit: RECENT_FAILURE_FETCH_LIMIT }),
    fetchStateMachineExecutions(config, idToken, { limit: RECENT_FAILURE_FETCH_LIMIT }),
  ]);

  return {
    tenants,
    insight: summary === null ? null : indexSummaryByTenantId(summary),
    recentFailures: buildRecentFailures(pipeline?.items ?? [], stateMachine?.items ?? []),
    insightUnavailable: summary === null || pipeline === null,
  };
}

function isForbiddenAdminInsightError(err: unknown): boolean {
  return err instanceof AdminInsightApiError && err.status === StatusCodes.FORBIDDEN;
}

export interface OperationsSnapshotState {
  readonly snapshot: OperationsSnapshot | null;
  readonly error: string | null;
  readonly forbidden: boolean;
  readonly refresh: (isActive?: () => boolean) => Promise<void>;
}

/**
 * Operations page のデータ層 hook。 fetch + 60 秒 polling + error 分類 (forbidden / loud error) を
 * 担い、 描画に必要な状態と手動 refresh を返す。
 */
export function useOperationsSnapshot(config: AppConfig): OperationsSnapshotState {
  const api = useApiClient(config);
  const auth = useAuth();
  const [snapshot, setSnapshot] = useState<OperationsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const idToken = auth.tokens?.idToken;
  const refresh = useCallback(
    async (isActive: () => boolean = () => true) => {
      if (!api || !idToken) return;
      try {
        const nextSnapshot = await fetchOperationsSnapshot(config, idToken, api);
        if (!isActive()) return;
        setSnapshot(nextSnapshot);
        setError(null);
        setForbidden(false);
      } catch (err) {
        if (!isActive()) return;
        if (isForbiddenAdminInsightError(err)) {
          setForbidden(true);
          setError(null);
          setSnapshot((prev) =>
            prev ? { ...prev, insight: null, recentFailures: [], insightUnavailable: false } : null,
          );
          return;
        }
        setError(toErrorMessage(err));
        setForbidden(false);
      }
    },
    [api, config, idToken],
  );

  usePolling(refresh, ADMIN_POLL_INTERVAL_MS, { enabled: Boolean(api && idToken) });

  return { snapshot, error, forbidden, refresh };
}
