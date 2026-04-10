/**
 * Gameday Team Create API Proxy
 *
 * チーム作成エンドポイント
 */

import { auth } from '@/auth';
import { getGamedayApiUrl } from '@/lib/api/backend-urls';
import { createLocalTeamWithInvite } from '@/lib/api/gameday-local';

export async function POST(request: Request) {
  const body = await request.json();
  const session = await auth();
  const userId = session?.user?.email ?? 'anonymous';

  try {
    const gamedayUrl = getGamedayApiUrl();
    const response = await fetch(`${gamedayUrl}/teams/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, userId }),
    });
    const data = await response.json();
    return Response.json(data, { status: response.status });
  } catch {
    const data = createLocalTeamWithInvite(
      body.eventId,
      userId,
      body.teamId,
      body.teamName,
    );
    return Response.json(data);
  }
}
