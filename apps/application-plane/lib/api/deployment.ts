/**
 * Deployment API Client
 *
 * CloudFormation デプロイ管理用 API クライアント
 */

import type { DeploymentStatus, DeployProblemResponse } from './admin-types';
import { del, get, post } from './client';

/**
 * 問題を AWS にデプロイ
 */
export async function deployProblem(
  problemId: string,
  region: string,
  parameters?: Record<string, string>,
): Promise<DeployProblemResponse> {
  return post<DeployProblemResponse>(`/admin/problems/${problemId}/deploy`, {
    region,
    parameters,
  });
}

/**
 * デプロイステータスを取得
 */
export async function getDeployStatus(
  problemId: string,
): Promise<DeploymentStatus> {
  return get<DeploymentStatus>(`/admin/problems/${problemId}/deploy`);
}

/**
 * デプロイメントを削除
 */
export async function deleteDeployment(
  problemId: string,
): Promise<{ message: string }> {
  return del<{ message: string }>(`/admin/problems/${problemId}/deploy`);
}
