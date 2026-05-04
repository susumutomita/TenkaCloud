import type { ApiClient } from "./client";

export const JOB_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function parseStackOutputs(json: string | undefined): Record<string, string> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
  } catch {
    // stackOutputs は best-effort 表示。壊れた JSON でページを落とさない。
  }
  return {};
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
  readonly teamName: string;
  readonly namePrefix: string;
  readonly status: DeploymentStatus;
  readonly stackId?: string;
  readonly stackOutputs?: string;
  readonly failureReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: number;
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
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.cursor) qs.set("cursor", params.cursor);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return client.get<ListDeploymentsResponse>(
    `/problems/${encodeURIComponent(problemId)}/deployments${suffix}`,
  );
}
