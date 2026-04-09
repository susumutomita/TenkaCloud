/**
 * Deployment API Client
 *
 * CloudFormation デプロイ管理用 API クライアント
 */

import type { DeploymentStatus, DeployProblemResponse } from './admin-types';
import { del, get, post } from './client';

export interface DeployTarget {
  provider: 'aws' | 'local';
  region: string;
  stackName: string;
}

export async function deployProblem(
  problemId: string,
  provider: 'aws' | 'local',
  region: string,
  parameters?: Record<string, string>,
): Promise<DeployProblemResponse> {
  return post<DeployProblemResponse>(`/admin/problems/${problemId}/deploy`, {
    provider,
    region,
    parameters,
  });
}

export async function getDeployStatus(
  problemId: string,
  target: DeployTarget,
): Promise<DeploymentStatus> {
  return get<DeploymentStatus>(`/admin/problems/${problemId}/deploy`, {
    stackName: target.stackName,
    provider: target.provider,
    region: target.region,
  });
}

export async function deleteDeployment(
  problemId: string,
  target: DeployTarget,
): Promise<{ message: string }> {
  return del<{ message: string }>(
    `/admin/problems/${problemId}/deploy?stackName=${encodeURIComponent(target.stackName)}&provider=${encodeURIComponent(target.provider)}&region=${encodeURIComponent(target.region)}`,
  );
}
