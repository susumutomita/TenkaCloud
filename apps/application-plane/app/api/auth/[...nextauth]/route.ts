import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { authSkipEnabled, handlers, mockSession } from '@/auth';

/**
 * AUTH_SKIP=1 の場合、/api/auth/session に対してモックセッションを返す。
 * NextAuth の handlers.GET は実際のセッションクッキーに依存するため、
 * クライアント側の useSession() がモックセッションを取得できない。
 */
const wrappedGET = authSkipEnabled
  ? (request: NextRequest) => {
      if (request.nextUrl.pathname === '/api/auth/session') {
        return NextResponse.json(mockSession);
      }
      return handlers.GET(request);
    }
  : handlers.GET;

export { wrappedGET as GET };
export const { POST } = handlers;
