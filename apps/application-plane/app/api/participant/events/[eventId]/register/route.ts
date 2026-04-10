/**
 * Participant Event Registration API Proxy
 */

import { authSkipEnabled } from '@/auth';
import {
  findDevEvent,
  setDevEventRegistration,
} from '@/app/api/admin/events/dev-store';
import { serverApiRequest } from '@/lib/api/server';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;

  try {
    const data = await serverApiRequest<{ success: boolean; message: string }>(
      `/participant/events/${eventId}/register`,
      { method: 'POST' },
    );
    return Response.json(data);
  } catch (error) {
    const isDevelopment = process.env.NODE_ENV !== 'production';
    const isAuthSkipUnauthorized =
      isDevelopment &&
      authSkipEnabled &&
      error instanceof Error &&
      /^Unauthorized$/i.test(error.message);
    const isNetworkError =
      isDevelopment &&
      error instanceof TypeError &&
      /fetch failed/i.test(String(error));

    if ((isAuthSkipUnauthorized || isNetworkError) && findDevEvent(eventId)) {
      setDevEventRegistration(eventId, true);
      return Response.json({
        success: true,
        message: 'Registered locally',
      });
    }

    const status =
      error instanceof Error && error.message.includes('400') ? 400 : 500;
    return Response.json(
      {
        error: error instanceof Error ? error.message : 'Failed to register',
      },
      { status },
    );
  }
}
