/**
 * Admin GameDay Deployments SSE Stream
 *
 * - GET: デプロイ状態をリアルタイムにストリーム
 */

import type { NextRequest } from 'next/server';
import { getAdminSession, API_BASE_URL } from '@/lib/api/server';

type RouteContext = {
  params: Promise<{ eventId: string; problemId: string }>;
};

export async function GET(request: NextRequest, { params }: RouteContext) {
  const session = await getAdminSession();
  if (!session) {
    return new Response('Unauthorized', { status: 401 });
  }

  const { eventId, problemId } = await params;

  const upstream = await fetch(
    `${API_BASE_URL}/admin/events/${eventId}/problems/${problemId}/deployments/stream`,
    {
      headers: {
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
      signal: request.signal,
    },
  );

  if (!upstream.ok || !upstream.body) {
    return new Response('Upstream SSE failed', { status: 502 });
  }

  return new Response(upstream.body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
