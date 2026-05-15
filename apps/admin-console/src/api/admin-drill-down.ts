import { StatusCodes } from "http-status-codes";
import type { AppConfig } from "../config";

/**
 * ADR-011 / #598 Phase 1.B drill-down 用 API client。
 *
 * AdminInsight API は ControlPlane API とは別 origin (= API GW HTTP API) で動く。
 * 既存の `ApiClient` は ControlPlane base URL に固定で使えないため、専用 fetch 関数を
 * 用意する。
 *
 * 全 endpoint で:
 *   - `config.adminInsightApiUrl` が空文字なら **null を返す** (= 未配線、UI は読み込み中扱い)
 *   - 403 (SystemAdmin claim 無し) は `PortalForbiddenError` で throw → caller が
 *     「権限不足」 banner を出す
 *   - 404 / 409 は ApiError として throw (status を保ったまま) → caller が分岐
 *   - その他 5xx / network error は通常の Error
 */

export type EventStatus = "DRAFT" | "DEPLOYING" | "READY" | "ENDED" | "TEARDOWN" | "ARCHIVED";
export type DeploymentStatus =
  | "PENDING"
  | "IN_PROGRESS"
  | "COMPLETE"
  | "FAILED"
  | "DELETING"
  | "DELETED";

export interface EventSummary {
  readonly eventId: string;
  readonly name: string;
  readonly status: EventStatus;
  readonly teamCount: number;
  readonly problemCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: number;
  readonly startsAt?: string;
  readonly endsAt?: string;
  readonly scoringLocked?: boolean;
  readonly scoringLockedAt?: string;
}

export interface ListEventsResponse {
  readonly items: readonly EventSummary[];
  readonly nextCursor?: string;
}

export interface EventProblemTarget {
  readonly problemId: string;
  readonly defaultAwsAccountId?: string;
  readonly defaultRegion: string;
}

export interface TeamSummary {
  readonly teamId: string;
  readonly internalSlug: string;
  readonly displayName?: string;
  /**
   * **System Admin 経路では常に undefined**。backend (`redactTeams`) が必ず潰す。
   * shape 上 field を残すのは、application-admin-console mirror が同じ shape を読むため。
   */
  readonly teamLoginKey?: string;
  readonly awsAccountId?: string;
}

export interface EventDeploymentSummary {
  readonly jobId: string;
  readonly teamId: string;
  readonly status: DeploymentStatus;
}

export interface EventDetail extends EventSummary {
  readonly problems: readonly EventProblemTarget[];
  readonly teams: readonly TeamSummary[];
  readonly deploymentsByProblem: Readonly<Record<string, readonly EventDeploymentSummary[]>>;
}

export interface DeploymentDetail {
  readonly jobId: string;
  readonly problemId: string;
  readonly tenantId: string;
  readonly awsAccountId: string;
  readonly region: string;
  readonly teamName: string;
  readonly displayTeamName?: string;
  readonly namePrefix: string;
  readonly status: DeploymentStatus;
  readonly stackId?: string;
  readonly stackOutputs?: string;
  readonly failureReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: number;
  readonly eventId?: string;
  readonly teamId?: string;
  /** **常に undefined**。System Admin 経路では露出しない。 */
  readonly teamLoginKey?: undefined;
}

export interface StackProgressEvent {
  readonly timestamp: string;
  readonly logicalResourceId: string;
  readonly resourceType: string;
  readonly resourceStatus: string;
  readonly resourceStatusReason?: string;
}

export interface StackProgressResource {
  readonly logicalResourceId: string;
  readonly resourceType: string;
  readonly resourceStatus: string;
  readonly resourceStatusReason?: string;
  readonly physicalResourceId?: string;
}

export interface StackProgress {
  readonly jobId: string;
  readonly stackName: string;
  readonly region: string;
  readonly consoleUrl: string;
  readonly events: readonly StackProgressEvent[];
  readonly resources: readonly StackProgressResource[];
  readonly stackStatus?: string;
  readonly stuck?: StackStuckDiagnosis;
}

export interface StackStuckDiagnosis {
  readonly isStuck: true;
  readonly elapsedMinutes: number;
  readonly observedAt: string;
  readonly reason: string;
  readonly remediationHint: string;
  readonly resourceLogicalId?: string;
  readonly resourceType?: string;
  readonly resourceStatus?: string;
}

export class AdminInsightApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`AdminInsight API ${status}: ${message}`);
    this.name = "AdminInsightApiError";
  }
}

function buildBaseUrl(config: AppConfig): string | null {
  if (!config.adminInsightApiUrl) return null;
  return config.adminInsightApiUrl.endsWith("/")
    ? config.adminInsightApiUrl
    : `${config.adminInsightApiUrl}/`;
}

async function adminInsightGet<T>(
  config: AppConfig,
  idToken: string,
  pathWithQuery: string,
): Promise<T | null> {
  const base = buildBaseUrl(config);
  if (!base) return null;
  const url = new URL(pathWithQuery.replace(/^\//, ""), base);
  const res = await fetch(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${idToken}`,
      "content-type": "application/json",
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new AdminInsightApiError(res.status, detail || res.statusText);
  }
  return (await res.json()) as T;
}

/**
 * GET /admin/insight/tenants/{tenantId}/events
 */
export async function fetchTenantEvents(
  config: AppConfig,
  idToken: string,
  tenantId: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<ListEventsResponse | null> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.cursor) params.set("cursor", options.cursor);
  const qs = params.toString();
  const path = `admin/insight/tenants/${encodeURIComponent(tenantId)}/events${qs ? `?${qs}` : ""}`;
  return adminInsightGet<ListEventsResponse>(config, idToken, path);
}

/**
 * GET /admin/insight/tenants/{tenantId}/events/{eventId}
 *
 * 404 (event 不在) は `AdminInsightApiError` で throw する (= status を残して caller 分岐)。
 */
export async function fetchTenantEventDetail(
  config: AppConfig,
  idToken: string,
  tenantId: string,
  eventId: string,
): Promise<EventDetail | null> {
  const path = `admin/insight/tenants/${encodeURIComponent(tenantId)}/events/${encodeURIComponent(
    eventId,
  )}`;
  return adminInsightGet<EventDetail>(config, idToken, path);
}

/**
 * GET /admin/insight/tenants/{tenantId}/deployments/{jobId}
 */
export async function fetchTenantDeploymentDetail(
  config: AppConfig,
  idToken: string,
  tenantId: string,
  jobId: string,
): Promise<DeploymentDetail | null> {
  const path = `admin/insight/tenants/${encodeURIComponent(tenantId)}/deployments/${encodeURIComponent(
    jobId,
  )}`;
  return adminInsightGet<DeploymentDetail>(config, idToken, path);
}

/**
 * GET /admin/insight/tenants/{tenantId}/deployments/{jobId}/stack-progress
 *
 * 409 (stack 未割当 = deploy 極初期) は AdminInsightApiError で throw する。
 * caller (AdminDeploymentDetail) が status を見て「準備中」表示に切替える。
 */
export async function fetchTenantStackProgress(
  config: AppConfig,
  idToken: string,
  tenantId: string,
  jobId: string,
): Promise<StackProgress | null> {
  const path = `admin/insight/tenants/${encodeURIComponent(tenantId)}/deployments/${encodeURIComponent(
    jobId,
  )}/stack-progress`;
  return adminInsightGet<StackProgress>(config, idToken, path);
}

/**
 * Issue #658: Provisioning Jobs page 用の execution item。
 * `GET /admin/insight/pipeline-executions` の response item shape。
 */
export interface PipelineExecutionItem {
  readonly executionId: string;
  readonly status: string;
  readonly startTimeIso: string | undefined;
  readonly lastUpdateTimeIso: string | undefined;
  readonly consoleUrl: string;
}

export interface ListPipelineExecutionsResponse {
  readonly pipelineName: string;
  readonly items: readonly PipelineExecutionItem[];
}

/**
 * `GET /admin/insight/pipeline-executions` を叩いて tenkacloud-saas-pipeline の execution
 * 履歴を取得する。 admin-console の Provisioning Jobs page (= /jobs) で使う。
 */
export async function fetchPipelineExecutions(
  config: AppConfig,
  idToken: string,
  options: { limit?: number } = {},
): Promise<ListPipelineExecutionsResponse | null> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  const qs = params.toString();
  const path = `admin/insight/pipeline-executions${qs ? `?${qs}` : ""}`;
  return adminInsightGet<ListPipelineExecutionsResponse>(config, idToken, path);
}

/**
 * CFn ResourceStatus を Cloudscape の StatusIndicator type に map する。
 * application-admin-console の `statusToIndicator` と同じセマンティクス。
 */
export function cfnStatusToIndicator(
  status: string,
): "success" | "error" | "in-progress" | "warning" | "stopped" {
  if (status === "DELETE_COMPLETE") return "stopped";
  if (status.endsWith("_FAILED")) return "error";
  if (status.includes("ROLLBACK")) return "warning";
  if (status.endsWith("_COMPLETE")) return "success";
  return "in-progress";
}

/**
 * Deployment status → StatusIndicator type の固定 map。
 */
export const DEPLOYMENT_STATUS_INDICATOR: Record<
  DeploymentStatus,
  "pending" | "in-progress" | "success" | "error" | "stopped"
> = {
  PENDING: "pending",
  IN_PROGRESS: "in-progress",
  COMPLETE: "success",
  FAILED: "error",
  DELETING: "in-progress",
  DELETED: "stopped",
};

/**
 * `StatusCodes.CONFLICT` 等で判定するときの shorthand。
 * caller: `if (err instanceof AdminInsightApiError && err.status === StatusCodes.CONFLICT)`
 */
export const ADMIN_INSIGHT_STATUS = StatusCodes;

/**
 * `stackOutputs` 文字列を `{key: value}` map に変換。
 * deploy-client.ts の `parseStackOutputs` と同等。
 */
export function parseStackOutputs(json: string | undefined): Record<string, string> {
  if (!json) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const out: Record<string, string> = {};
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      if (entry && typeof entry === "object") {
        const k = (entry as { OutputKey?: unknown }).OutputKey;
        const v = (entry as { OutputValue?: unknown }).OutputValue;
        if (typeof k === "string" && typeof v === "string") out[k] = v;
      }
    }
    return out;
  }
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
