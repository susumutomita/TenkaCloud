/**
 * Gameday My Membership Proxy
 *
 * 現在ユーザーのメンバーシップ取得エンドポイント
 */

import { NextRequest } from 'next/server';
import { auth } from '@/auth';
import { getGamedayApiUrl } from '@/lib/api/backend-urls';
import { getLocalMembership } from '@/lib/api/gameday-local';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const eventId = searchParams.get('eventId');
  if (!eventId) {
    return Response.json({ error: 'eventId は必須です' }, { status: 400 });
  }

  const session = await auth();
  const userId = session?.user?.email ?? 'anonymous';
  const shouldForwardDevIdentity =
    process.env.AUTH_SKIP === '1' && process.env.NODE_ENV !== 'production';

  try {
    const gamedayUrl = getGamedayApiUrl();
    const response = await fetch(
      `${gamedayUrl}/teams/my-membership?eventId=${encodeURIComponent(eventId)}`,
      {
        headers: {
          'Content-Type': 'application/json',
          ...(shouldForwardDevIdentity
            ? {
                'X-TenkaCloud-Dev-User-Id': userId,
                'X-TenkaCloud-Dev-Tenant-Id': session?.tenantId ?? 'dev-tenant',
                'X-TenkaCloud-Dev-Roles': (
                  session?.roles ?? ['participant']
                ).join(','),
              }
            : {}),
        },
      },
    );
    const data = await response.json();
    return Response.json(data, { status: response.status });
  } catch {
    return Response.json({ membership: getLocalMembership(eventId, userId) });
  }
}
