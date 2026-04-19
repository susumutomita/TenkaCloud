/**
 * Admin Event Service
 *
 * 管理者向け個別イベント操作のサービス層
 * バックエンド API 呼び出しとローカル dev store フォールバックを担当
 */

import { authSkipEnabled } from '@/auth';
import { serverApiRequest } from '@/lib/api/server';
import type { EventDetails } from '@/lib/api/types';
import {
  deleteDevEvent,
  findDevEvent,
  updateDevEvent,
} from '@/app/api/admin/events/dev-store';

/**
 * イベント更新リクエスト型
 */
export interface UpdateEventRequest {
  name?: string;
  slug?: string;
  description?: string;
  organizer?: string;
  eventDate?: string;
  startTime?: string;
  endTime?: string;
  status?: import('@/lib/api/types').EventStatus;
  imageUrl?: string;
}

function isLocalDevFallbackError(error: unknown): boolean {
  const isAuthSkipUnauthorized =
    authSkipEnabled &&
    error instanceof Error &&
    /^Unauthorized$/i.test(error.message);
  const isNetworkError =
    error instanceof TypeError && /fetch failed/i.test(String(error));
  return isAuthSkipUnauthorized || isNetworkError;
}

/**
 * イベント詳細を取得
 *
 * バックエンド API を試行し、失敗時はローカル dev store にフォールバック
 */
export async function fetchEvent(eventId: string): Promise<EventDetails> {
  try {
    return await serverApiRequest<EventDetails>(`/admin/events/${eventId}`);
  } catch (error) {
    if (isLocalDevFallbackError(error)) {
      console.warn('Admin event detail fallback to local dev store:', error);
      const event = findDevEvent(eventId);
      if (event) {
        return event as unknown as EventDetails;
      }
    }

    console.error('Failed to fetch event:', error);
    throw error instanceof Error ? error : new Error('Failed to fetch event');
  }
}

/**
 * イベントを更新
 *
 * バックエンド API を試行し、失敗時はローカル dev store にフォールバック
 */
export async function putEvent(
  eventId: string,
  body: UpdateEventRequest,
): Promise<EventDetails> {
  try {
    return await serverApiRequest<EventDetails>(`/admin/events/${eventId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (isLocalDevFallbackError(error)) {
      console.warn('Admin event update fallback to local dev store:', error);
      const event = updateDevEvent(eventId, body);
      if (event) {
        return event as unknown as EventDetails;
      }
    }

    console.error('Failed to update event:', error);
    throw error instanceof Error ? error : new Error('Failed to update event');
  }
}

/**
 * イベントを削除
 *
 * バックエンド API を試行し、失敗時はローカル dev store にフォールバック
 */
export async function removeEvent(
  eventId: string,
): Promise<{ success: boolean; message: string }> {
  try {
    await serverApiRequest<void>(`/admin/events/${eventId}`, {
      method: 'DELETE',
    });
    return { success: true, message: 'Event deleted' };
  } catch (error) {
    if (isLocalDevFallbackError(error) && deleteDevEvent(eventId)) {
      console.warn('Admin event delete fallback to local dev store:', error);
      return { success: true, message: 'Event deleted' };
    }

    console.error('Failed to delete event:', error);
    throw error instanceof Error ? error : new Error('Failed to delete event');
  }
}
