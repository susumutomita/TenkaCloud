/**
 * Gameday Team Join API Proxy
 *
 * 招待コードでチーム参加エンドポイント
 */

import { auth } from '@/auth';

export async function POST(request: Request) {
  const body = await request.json();
  const session = await auth();
  const userId = session?.user?.email ?? 'anonymous';

  const GAMEDAY_API_URL =
    process.env.GAMEDAY_API_URL || 'http://localhost:3020/api/gameday';
  const response = await fetch(`${GAMEDAY_API_URL}/teams/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, userId }),
  });
  const data = await response.json();
  return Response.json(data, { status: response.status });
}
