/**
 * Gameday Solo Registration Proxy
 *
 * ソロ参加登録エンドポイント
 */

import { z } from 'zod';
import { auth } from '@/auth';
import { getGamedayApiUrl } from '@/lib/api/backend-urls';
import { createLocalSoloMembership } from '@/lib/api/gameday-local';

const SoloJoinSchema = z.object({
  eventId: z.string().min(1),
});

export async function POST(request: Request) {
  const rawBody = await request.json();
  const parseResult = SoloJoinSchema.safeParse(rawBody);
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
    const response = await fetch(`${gamedayUrl}/teams/solo`, {
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
      console.error('Solo join failed:', error);
      return Response.json(
        { error: 'ソロ参加に失敗しました' },
        { status: 500 },
      );
    }
    const membership = createLocalSoloMembership(body.eventId, userId);
    return Response.json({ success: true, membership });
  }
}
