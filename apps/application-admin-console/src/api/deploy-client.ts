import type { ApiClient } from "./client";

export const JOB_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * DDB の `stackOutputs` 文字列を `{key: value}` map に変換。次の 2 形式を許容する:
 *   1. `{key: value}` (Lambda 由来)
 *   2. `[{OutputKey, OutputValue}, ...]` (Step Functions describeStacks 由来)
 *
 * Backend (`infrastructure/lib/problem-deploy/handlers/shared/cfn-status.ts`) に同じ
 * 関数の sister 実装あり。両者は意味的に同一にする (frontend / backend の DTO 共有)。
 *
 * 壊れた JSON / 非 string value は無視 (best-effort 表示、ページを落とさない)。
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

export type DeploymentStatus =
  | "PENDING"
  | "IN_PROGRESS"
  | "COMPLETE"
  | "FAILED"
  | "DELETING"
  | "DELETED";

export const TERMINAL_STATUSES: ReadonlySet<DeploymentStatus> = new Set([
  "COMPLETE",
  "FAILED",
  "DELETED",
]);

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

export interface DeployRequestBody {
  readonly region: string;
  readonly awsAccountId: string;
  readonly teamName: string;
}

export interface DeployResponse {
  readonly jobId: string;
  readonly status: DeploymentStatus;
  readonly namePrefix: string;
  /** チーム共有ログインキー。レスポンスで 1 度だけ露出するので、UI 側で表示し別途控える。 */
  readonly teamLoginKey: string;
  readonly expiresAt: number;
}

export interface DeploymentSummary {
  readonly jobId: string;
  readonly problemId: string;
  readonly tenantId: string;
  readonly awsAccountId: string;
  readonly region: string;
  /** Operator が deploy form で入力した内部 slug (CFn StackName 由来、immutable)。 */
  readonly teamName: string;
  /** 競技者が portal で設定した表示用チーム名。未設定なら undefined。 */
  readonly displayTeamName?: string;
  readonly namePrefix: string;
  readonly status: DeploymentStatus;
  readonly stackId?: string;
  readonly stackOutputs?: string;
  readonly failureReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: number;
  /** 単一行 Get でのみ返る。`listDeployments` の戻り値には含まれない (誤露出防止)。 */
  readonly teamLoginKey?: string;
}

export interface ListDeploymentsResponse {
  readonly items: readonly DeploymentSummary[];
  readonly nextCursor?: string;
}

export function startDeployment(
  client: ApiClient,
  problemId: string,
  body: DeployRequestBody,
): Promise<DeployResponse> {
  return client.post<DeployResponse>(`/problems/${encodeURIComponent(problemId)}/deploy`, body);
}

export function getDeployment(client: ApiClient, jobId: string): Promise<DeploymentSummary> {
  return client.get<DeploymentSummary>(`/deployments/${encodeURIComponent(jobId)}`);
}

export function deleteDeployment(client: ApiClient, jobId: string): Promise<void> {
  return client.del(`/deployments/${encodeURIComponent(jobId)}`);
}

export interface ListDeploymentsParams {
  readonly limit?: number;
  readonly cursor?: string;
}

export function listDeployments(
  client: ApiClient,
  problemId: string,
  params: ListDeploymentsParams = {},
): Promise<ListDeploymentsResponse> {
  return fetchDeployments(client, `/problems/${encodeURIComponent(problemId)}/deployments`, params);
}

/** Tenant 内の deployment 一覧 (problemId scope なし)。サイドバー「デプロイ履歴」が引く。 */
export function listAllDeployments(
  client: ApiClient,
  params: ListDeploymentsParams = {},
): Promise<ListDeploymentsResponse> {
  return fetchDeployments(client, "/deployments", params);
}

function fetchDeployments(
  client: ApiClient,
  basePath: string,
  params: ListDeploymentsParams,
): Promise<ListDeploymentsResponse> {
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.cursor) qs.set("cursor", params.cursor);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return client.get<ListDeploymentsResponse>(`${basePath}${suffix}`);
}
