import type { FetchAuthConfig } from "../http/fetch-with-auth.ts";
import { fetchWithAuth } from "../http/fetch-with-auth.ts";

/**
 * Issue #1305: Problem deploy backend client。
 * `ProblemDeployBackendStack` HTTP API: `/deployments`。
 */

export interface DeploymentSummary {
  readonly deploymentId: string;
  readonly eventId?: string;
  readonly teamId?: string;
  readonly problemId?: string;
  readonly status?: string;
  readonly createdAt?: string;
}

export interface DeployLog {
  readonly timestamp: string;
  readonly message: string;
  readonly level?: string;
}

export class DeployApi {
  constructor(
    private readonly baseUrl: string,
    private readonly authConfig: FetchAuthConfig,
  ) {}

  async deploy(eventId: string, teamId: string, problemId: string): Promise<DeploymentSummary> {
    return (await fetchWithAuth(
      this.baseUrl,
      "/deployments",
      { method: "POST", body: { eventId, teamId, problemId } },
      this.authConfig,
    )) as DeploymentSummary;
  }

  async bulkDeploy(eventId: string): Promise<DeploymentSummary[]> {
    const res = (await fetchWithAuth(
      this.baseUrl,
      "/deployments/bulk",
      { method: "POST", body: { eventId } },
      this.authConfig,
    )) as { data?: DeploymentSummary[] } | DeploymentSummary[] | undefined;
    if (Array.isArray(res)) return res;
    return res?.data ?? [];
  }

  async status(deploymentId: string): Promise<DeploymentSummary> {
    return (await fetchWithAuth(
      this.baseUrl,
      `/deployments/${encodeURIComponent(deploymentId)}`,
      {},
      this.authConfig,
    )) as DeploymentSummary;
  }

  async logs(deploymentId: string): Promise<DeployLog[]> {
    const res = (await fetchWithAuth(
      this.baseUrl,
      `/deployments/${encodeURIComponent(deploymentId)}/logs`,
      {},
      this.authConfig,
    )) as { data?: DeployLog[]; logs?: DeployLog[] } | DeployLog[] | undefined;
    if (Array.isArray(res)) return res;
    return res?.data ?? res?.logs ?? [];
  }
}
