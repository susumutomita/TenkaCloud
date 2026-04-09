/**
 * Admin Activities API
 *
 * 管理画面トップの最近のアクティビティを返す。
 * まずは空配列を返してダッシュボードの 404 を解消する。
 */

import {
  forbiddenResponse,
  getAdminSession,
  successResponse,
  unauthorizedResponse,
} from '@/lib/api/server';

interface ActivityEntry {
  id: string;
  type: string;
  message: string;
  timestamp: string;
}

export async function GET() {
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  const activities: ActivityEntry[] = [];
  return successResponse({ activities });
}
