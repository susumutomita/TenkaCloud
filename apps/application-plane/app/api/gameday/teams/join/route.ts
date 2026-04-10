/**
 * Gameday Team Join API Proxy
 *
 * 招待コードでチーム参加エンドポイント
 */

import { auth } from '@/auth';
import { getGamedayApiUrl } from '@/lib/api/backend-urls';
import { joinLocalTeamByInvite } from '@/lib/api/gameday-local';

export async function POST(request: Request) {
  const body = await request.json();
  const session = await auth();
  const userId = session?.user?.email ?? 'anonymous';

  try {
    const gamedayUrl = getGamedayApiUrl();
    const response = await fetch(`${gamedayUrl}/teams/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, userId }),
    });
    const data = await response.json();
    return Response.json(data, { status: response.status });
  } catch {
    const membership = joinLocalTeamByInvite(
      body.eventId,
      userId,
      body.inviteCode,
    );
    if (!membership) {
      return Response.json({ error: '招待コードが無効です' }, { status: 400 });
    }
    return Response.json(membership);
  }
}
