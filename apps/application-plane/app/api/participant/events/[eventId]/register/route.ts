/**
 * Participant Event Registration API Proxy
 */

import { serverApiRequest } from '@/lib/api/server';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ eventId: string }> }
) {
  const { eventId } = await params;

  try {
    const data = await serverApiRequest<{ success: boolean; message: string }>(
      `/participant/events/${eventId}/register`,
      { method: 'POST' }
    );
    return Response.json(data);
  } catch (error) {
    const status =
      error instanceof Error && error.message.includes('400') ? 400 : 500;
    return Response.json(
      {
        error: error instanceof Error ? error.message : 'Failed to register',
      },
      { status }
    );
  }
}
