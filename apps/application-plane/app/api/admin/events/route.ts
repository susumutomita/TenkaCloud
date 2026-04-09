/**
 * Admin Events API
 *
 * 管理者向けイベント管理エンドポイント
 * - GET: イベント一覧取得
 * - POST: イベント作成
 */

import { NextRequest } from 'next/server';
import { authSkipEnabled } from '@/auth';
import {
  getAdminSession,
  unauthorizedResponse,
  forbiddenResponse,
  badRequestResponse,
  successResponse,
  serverApiRequest,
} from '@/lib/api/server';
import type { ParticipantEvent, EventStatus } from '@/lib/api/types';

interface DevEventRecord extends ParticipantEvent {
  slug: string;
  createdAt: string;
}

function getDevEventStore(): DevEventRecord[] {
  const globalStore = globalThis as typeof globalThis & {
    __TENKACLOUD_DEV_EVENTS__?: DevEventRecord[];
  };
  if (!globalStore.__TENKACLOUD_DEV_EVENTS__) {
    globalStore.__TENKACLOUD_DEV_EVENTS__ = [];
  }
  return globalStore.__TENKACLOUD_DEV_EVENTS__;
}

/**
 * Admin イベント一覧レスポンス型
 */
interface AdminEventListResponse {
  events: ParticipantEvent[];
  total: number;
  page: number;
  pageSize: number;
}

function emptyEventList(page: number, pageSize: number): AdminEventListResponse {
  return {
    events: [],
    total: 0,
    page,
    pageSize,
  };
}

function buildDevEventList(
  page: number,
  pageSize: number,
  status?: EventStatus | null,
): AdminEventListResponse {
  const store = getDevEventStore();
  const filtered = status
    ? store.filter((event) => event.status === status)
    : store;
  const offset = Math.max(page - 1, 0) * pageSize;
  return {
    events: filtered.slice(offset, offset + pageSize),
    total: filtered.length,
    page,
    pageSize,
  };
}

function createDevEvent(body: CreateEventRequest): DevEventRecord {
  const now = new Date().toISOString();
  const event: DevEventRecord = {
    id: `dev-event-${Date.now()}`,
    slug: body.slug?.trim() || `event-${Date.now()}`,
    name: body.name,
    type: (body.type as ParticipantEvent['type']) || 'gameday',
    status: body.status || 'draft',
    startTime: body.startTime || new Date().toISOString(),
    endTime:
      body.endTime ||
      new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    timezone: body.timezone || 'Asia/Tokyo',
    participantType:
      (body.participantType as ParticipantEvent['participantType']) ||
      'individual',
    cloudProvider:
      (body.cloudProvider as ParticipantEvent['cloudProvider']) || 'aws',
    regions: body.regions?.length ? body.regions : ['ap-northeast-1'],
    scoringType:
      (body.scoringType as ParticipantEvent['scoringType']) || 'realtime',
    leaderboardVisible: body.leaderboardVisible ?? true,
    problemCount: 0,
    participantCount: 0,
    isRegistered: false,
    createdAt: now,
  };
  getDevEventStore().unshift(event);
  return event;
}

/**
 * イベント作成リクエスト型
 */
interface CreateEventRequest {
  name: string;
  slug?: string;
  description?: string;
  organizer?: string;
  eventDate?: string;
  startTime?: string;
  endTime?: string;
  status?: EventStatus;
  imageUrl?: string;
  type?: string;
  timezone?: string;
  participantType?: string;
  cloudProvider?: string;
  regions?: string[];
  scoringType?: string;
  leaderboardVisible?: boolean;
}

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
      console.warn('Admin events fallback to empty dataset:', error);
      return successResponse(buildDevEventList(page, pageSize, status));
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

  const body = (await request.json()) as CreateEventRequest;

  try {
    // 必須フィールドのバリデーション
    if (!body.name?.trim()) {
      return badRequestResponse('Event name is required');
    }
    if (!body.startTime?.trim()) {
      return badRequestResponse('Event start time is required');
    }
    if (!body.endTime?.trim()) {
      return badRequestResponse('Event end time is required');
    }

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
      console.warn('Admin events create fallback to local dev store:', error);
      return successResponse(createDevEvent(body), 201);
    }

    console.error('Failed to create event:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to create event',
    );
  }
}
