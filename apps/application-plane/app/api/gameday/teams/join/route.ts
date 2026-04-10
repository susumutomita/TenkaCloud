/**
 * Gameday Team Join API Proxy
 *
 * 招待コードでチーム参加エンドポイント
 */

import { z } from 'zod';
import { auth } from '@/auth';
import { getGamedayApiUrl } from '@/lib/api/backend-urls';
import { joinLocalTeamByInvite } from '@/lib/api/gameday-local';

const JoinTeamSchema = z.object({
  eventId: z.string().min(1),
  inviteCode: z.string().min(1),
});

export async function POST(request: Request) {
  const rawBody = await request.json();
  const parseResult = JoinTeamSchema.safeParse(rawBody);
  if (!parseResult.success) {
    return Response.json(
      { error: 'Invalid request body', details: parseResult.error.flatten() },
      { status: 400 },
    );
  }
  const body = parseResult.data;
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
  } catch (error) {
    const isNetworkError =
      error instanceof TypeError && /fetch failed/i.test(String(error));
    if (!isNetworkError) {
      console.error('Team join failed:', error);
      return Response.json(
        { error: 'チーム参加に失敗しました' },
        { status: 500 },
      );
    }
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
