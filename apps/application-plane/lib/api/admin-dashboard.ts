/**
 * Admin Dashboard API Client
 *
 * 管理画面ダッシュボード用の API クライアント
 */

import { get } from './client';

/**
 * ダッシュボード統計情報
 */
export interface DashboardStats {
  activeEvents: number;
  totalParticipants: number;
  totalTeams: number;
  upcomingEvents: number;
}

/**
 * アクティビティエントリ
 */
export interface ActivityEntry {
  id: string;
  type: string;
  message: string;
  timestamp: string;
}

/**
 * ダッシュボード統計を取得
 */
export async function getDashboardStats(): Promise<DashboardStats> {
  return get<DashboardStats>('/admin/dashboard/stats');
}

/**
 * 最近のアクティビティを取得
 */
export async function getRecentActivities(
  limit = 10,
): Promise<{ activities: ActivityEntry[] }> {
  return get<{ activities: ActivityEntry[] }>('/admin/activities', { limit });
}
