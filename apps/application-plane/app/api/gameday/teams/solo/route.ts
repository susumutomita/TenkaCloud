/**
 * Gameday Solo Registration Proxy
 *
 * ソロ参加登録エンドポイント
 */

import { auth } from '@/auth';
import { getGamedayApiUrl } from '@/lib/api/backend-urls';

export async function POST(request: Request) {
  const body = await request.json();
  const session = await auth();
  const userId = session?.user?.email ?? 'anonymous';

  const gamedayUrl = getGamedayApiUrl();
  const response = await fetch(`${gamedayUrl}/teams/solo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, userId }),
  });
  const data = await response.json();
  return Response.json(data, { status: response.status });
}
