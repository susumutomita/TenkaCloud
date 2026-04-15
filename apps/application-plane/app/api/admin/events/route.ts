/**
 * Admin Events API
 *
 * 管理者向けイベント管理エンドポイント
 * - GET: イベント一覧取得
 * - POST: イベント作成
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { authSkipEnabled } from '@/auth';
import {
  getAdminSession,
  unauthorizedResponse,
  forbiddenResponse,
  badRequestResponse,
  successResponse,
  serviceUnavailableResponse,
  serverApiRequest,
} from '@/lib/api/server';
import type { ParticipantEvent, EventStatus } from '@/lib/api/types';
import { createDevEvent, listDevEvents } from './dev-store';

/**
 * Admin イベント一覧レスポンス型
 */
interface AdminEventListResponse {
  events: ParticipantEvent[];
  total: number;
  page: number;
  pageSize: number;
}

function emptyEventList(
  page: number,
  pageSize: number,
): AdminEventListResponse {
  return {
    events: [],
    total: 0,
    page,
    pageSize,
  };
}

/**
 * イベント作成リクエスト型
 */
const createEventRequestSchema = z.object({
  name: z
    .string({
      required_error: 'Event name is required',
      invalid_type_error: 'Event name is required',
    })
    .trim()
    .min(1, 'Event name is required'),
  slug: z.string().trim().min(1).optional(),
  description: z.string().optional(),
  organizer: z.string().optional(),
  eventDate: z.string().optional(),
  startTime: z
    .string({
      required_error: 'Event start time is required',
      invalid_type_error: 'Event start time is required',
    })
    .trim()
    .min(1, 'Event start time is required'),
  endTime: z
    .string({
      required_error: 'Event end time is required',
      invalid_type_error: 'Event end time is required',
    })
    .trim()
    .min(1, 'Event end time is required'),
  status: z.custom<EventStatus>().optional(),
  imageUrl: z.string().optional(),
  type: z.string().optional(),
  timezone: z.string().optional(),
  participantType: z.string().optional(),
  cloudProvider: z.string().optional(),
  regions: z.array(z.string()).optional(),
  scoringType: z.string().optional(),
  leaderboardVisible: z.boolean().optional(),
});

type CreateEventRequest = z.infer<typeof createEventRequestSchema>;

/**
 * GET /api/admin/events
 *
 * イベント一覧を取得（管理者のみ）
 */
export async function GET(request: NextRequest) {
  // 管理者権限チェック
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  // クエリパラメータ取得
  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get('page') || '1', 10);
  const pageSize = parseInt(searchParams.get('pageSize') || '10', 10);
  const status = searchParams.get('status') as EventStatus | null;
  const search = searchParams.get('search');

  try {
    // バックエンド API を呼び出し
    const queryParams = new URLSearchParams();
    queryParams.set('page', String(page));
    queryParams.set('pageSize', String(pageSize));
    if (status) queryParams.set('status', status);
    if (search) queryParams.set('search', search);

    const data = await serverApiRequest<AdminEventListResponse>(
      `/admin/events?${queryParams.toString()}`,
    );

    return successResponse(data);
  } catch (error) {
    const isAuthSkipUnauthorized =
      authSkipEnabled &&
      error instanceof Error &&
      /^Unauthorized$/i.test(error.message);
    const isNetworkError =
      error instanceof TypeError && /fetch failed/i.test(String(error));

    if (isAuthSkipUnauthorized || isNetworkError) {
      console.error('Admin events backend unreachable:', error);
      return serviceUnavailableResponse('Failed to fetch events');
    }

    console.error('Failed to fetch events:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to fetch events',
    );
  }
}

/**
 * POST /api/admin/events
 *
 * 新規イベントを作成（管理者のみ）
 */
export async function POST(request: NextRequest) {
  // 管理者権限チェック
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  const json = await request
    .json()
    .catch(() => null satisfies null | Record<string, unknown>);
  if (json === null) {
    return badRequestResponse('Invalid request');
  }

  const parsedBody = createEventRequestSchema.safeParse(json);

  if (!parsedBody.success) {
    return badRequestResponse(
      parsedBody.error.issues[0]?.message ?? 'Invalid request',
    );
  }

  const body = parsedBody.data;

  try {
    // バックエンド API を呼び出し
    const data = await serverApiRequest<ParticipantEvent>('/admin/events', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    return successResponse(data, 201);
  } catch (error) {
    const isAuthSkipUnauthorized =
      authSkipEnabled &&
      error instanceof Error &&
      /^Unauthorized$/i.test(error.message);
    const isNetworkError =
      error instanceof TypeError && /fetch failed/i.test(String(error));

    if (isAuthSkipUnauthorized || isNetworkError) {
      console.error('Admin events create backend unreachable:', error);
      return serviceUnavailableResponse('Failed to create event');
    }

    console.error('Failed to create event:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to create event',
    );
  }
}
