/**
 * Gameday My Membership Proxy
 *
 * 現在ユーザーのメンバーシップ取得エンドポイント
 */

import { NextRequest } from 'next/server';
import { auth } from '@/auth';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const eventId = searchParams.get('eventId');
  if (!eventId) {
    return Response.json({ error: 'eventId は必須です' }, { status: 400 });
  }

  const session = await auth();
  const userId = session?.user?.email ?? 'anonymous';

  const GAMEDAY_API_URL =
    process.env.GAMEDAY_API_URL || 'http://localhost:3020/api/gameday';
  const response = await fetch(
    `${GAMEDAY_API_URL}/teams/my-membership?eventId=${encodeURIComponent(eventId)}&userId=${encodeURIComponent(userId)}`,
    { headers: { 'Content-Type': 'application/json' } }
  );
  const data = await response.json();
  return Response.json(data, { status: response.status });
}
