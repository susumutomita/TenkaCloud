/**
 * Gameday Team Create API Proxy
 *
 * チーム作成エンドポイント
 */

import { z } from 'zod';
import { auth } from '@/auth';
import { getGamedayApiUrl } from '@/lib/api/backend-urls';
import { createLocalTeamWithInvite } from '@/lib/api/gameday-local';

const CreateTeamSchema = z.object({
  eventId: z.string().min(1),
  teamId: z.string().min(1),
  teamName: z.string().min(1),
});

export async function POST(request: Request) {
  const rawBody = await request.json();
  const parseResult = CreateTeamSchema.safeParse(rawBody);
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
    const response = await fetch(`${gamedayUrl}/teams/create`, {
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
      console.error('Team create failed:', error);
      return Response.json(
        { error: 'チーム作成に失敗しました' },
        { status: 500 },
      );
    }
    const data = createLocalTeamWithInvite(
      body.eventId,
      userId,
      body.teamId,
      body.teamName,
    );
    return Response.json(data);
  }
}
