/**
 * Participant Event Leaderboard API Proxy
 */

import { serverApiRequest } from '@/lib/api/server';
import type { Leaderboard } from '@/lib/api/types';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;

  try {
    const data = await serverApiRequest<Leaderboard>(
      `/participant/events/${eventId}/leaderboard`,
    );
    return Response.json(data);
  } catch (error) {
    // リーダーボードが取得できない場合は空データを返す
    if (error instanceof Error && error.message.includes('404')) {
      return Response.json({ entries: [], total: 0 });
    }
    return Response.json({ entries: [], total: 0 }, { status: 500 });
  }
}
