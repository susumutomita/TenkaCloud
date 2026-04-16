/**
 * Profile API Proxy
 *
 * - GET: プロフィール取得
 * - PUT: プロフィール更新
 */

import { NextRequest } from 'next/server';
import {
  serverApiRequest,
  successResponse,
  badRequestResponse,
} from '@/lib/api/server';

export async function GET() {
  const data = await serverApiRequest('/participant/profile');
  return successResponse(data);
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const data = await serverApiRequest('/participant/profile', {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    return successResponse(data);
  } catch (error) {
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to update profile',
    );
  }
}
