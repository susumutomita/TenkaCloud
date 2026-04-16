/**
 * Admin Competitor Accounts API
 *
 * - GET:  イベントの競技アカウント一覧
 * - POST: 競技アカウント登録
 */

import type { NextRequest } from 'next/server';
import {
  getAdminSession,
  unauthorizedResponse,
  forbiddenResponse,
  badRequestResponse,
  successResponse,
  serverApiRequest,
} from '@/lib/api/server';

type RouteContext = { params: Promise<{ eventId: string }> };

export async function GET(_request: NextRequest, { params }: RouteContext) {
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  const { eventId } = await params;

  try {
    const data = await serverApiRequest(
      `/admin/events/${eventId}/competitor-accounts`,
    );
    return successResponse(data);
  } catch (error) {
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to list accounts',
    );
  }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  const { eventId } = await params;

  try {
    const body = await request.json();
    const data = await serverApiRequest(
      `/admin/events/${eventId}/competitor-accounts`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    return successResponse(data, 201);
  } catch (error) {
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to create account',
    );
  }
}
