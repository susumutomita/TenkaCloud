/**
 * Admin Problems API Client
 *
 * 管理画面用の問題管理 API クライアント
 */

import type {
  AdminProblem,
  AdminProblemFilters,
  AdminProblemListResponse,
  AWSRegion,
  CreateProblemRequest,
  DeploymentStatus,
  DeployProblemRequest,
  DeployProblemResponse,
  UpdateProblemRequest,
} from './admin-types';
import { del, get, post, put } from './client';

/**
 * 問題一覧を取得
 */
export async function getProblems(
  filters?: AdminProblemFilters & { limit?: number; offset?: number }
): Promise<AdminProblemListResponse> {
  return get<AdminProblemListResponse>('/admin/problems', {
    type: filters?.type,
    category: filters?.category,
    difficulty: filters?.difficulty,
    limit: filters?.limit,
    offset: filters?.offset,
  });
}

/**
 * 問題詳細を取得
 */
export async function getProblem(problemId: string): Promise<AdminProblem> {
  return get<AdminProblem>(`/admin/problems/${problemId}`);
}

/**
 * 問題を作成
 */
export async function createProblem(
  data: CreateProblemRequest
): Promise<AdminProblem> {
  return post<AdminProblem>('/admin/problems', data);
}

/**
 * 問題を更新
 */
export async function updateProblem(
  problemId: string,
  data: UpdateProblemRequest
): Promise<AdminProblem> {
  return put<AdminProblem>(`/admin/problems/${problemId}`, data);
}

/**
 * 問題を削除
 */
export async function deleteProblem(
  problemId: string
): Promise<{ success: boolean }> {
  return del<{ success: boolean }>(`/admin/problems/${problemId}`);
}

/**
 * 問題を AWS にデプロイ
 */
export async function deployProblem(
  problemId: string,
  data: DeployProblemRequest
): Promise<DeployProblemResponse> {
  return post<DeployProblemResponse>(
    `/admin/problems/${problemId}/deploy`,
    data
  );
}

/**
 * デプロイステータスを取得
 */
export async function getDeploymentStatus(
  problemId: string,
  stackName: string,
  region: string
): Promise<DeploymentStatus> {
  return get<DeploymentStatus>(
    `/admin/problems/${problemId}/deployments/${stackName}/status`,
    { region }
  );
}

/**
 * デプロイメントを削除
 */
export async function deleteDeployment(
  problemId: string,
  stackName: string,
  region: string
): Promise<{ message: string; stackName: string }> {
  return del<{ message: string; stackName: string }>(
    `/admin/problems/${problemId}/deployments/${stackName}?region=${region}`
  );
}

/**
 * 利用可能な AWS リージョン一覧を取得
 */
export async function getAWSRegions(): Promise<{ regions: AWSRegion[] }> {
  return get<{ regions: AWSRegion[] }>('/admin/aws/regions');
}
