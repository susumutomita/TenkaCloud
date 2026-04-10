/**
 * Participant Event Unregistration API Proxy
 *
 * - POST: イベント登録解除
 */

import { serverApiRequest } from '@/lib/api/server';
import { authSkipEnabled } from '@/auth';
import {
  findDevEvent,
  setDevEventRegistration,
} from '@/app/api/admin/events/dev-store';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;

  try {
    const data = await serverApiRequest<{ success: boolean; message: string }>(
      `/participant/events/${eventId}/unregister`,
      { method: 'POST' },
    );
    return Response.json(data);
  } catch (error) {
    const isAuthSkipUnauthorized =
      authSkipEnabled &&
      error instanceof Error &&
      /^Unauthorized$/i.test(error.message);
    const isNetworkError =
      error instanceof TypeError && /fetch failed/i.test(String(error));

    if ((isAuthSkipUnauthorized || isNetworkError) && findDevEvent(eventId)) {
      setDevEventRegistration(eventId, false);
      return Response.json({
        success: true,
        message: 'Unregistered locally',
      });
    }

    const status =
      error instanceof Error && error.message.includes('400') ? 400 : 500;
    return Response.json(
      {
        error: error instanceof Error ? error.message : 'Failed to unregister',
      },
      { status },
    );
  }
}
