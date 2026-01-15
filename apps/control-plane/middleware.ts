import { type NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';

// next.config.ts の basePath と一致させる
const BASE_PATH = '/control';

/**
 * 認証ミドルウェアのコアロジック
 */
function handleAuth(isLoggedIn: boolean, req: NextRequest): NextResponse {
  const isOnLoginPage = req.nextUrl.pathname.startsWith('/login');
  const isOnApiAuthRoute = req.nextUrl.pathname.startsWith('/api/auth');

  // API 認証ルートは常にアクセス可能
  if (isOnApiAuthRoute) {
    return NextResponse.next();
  }

  // 未認証ユーザーがログインページ以外にアクセスした場合、ログインページにリダイレクト
  if (!isLoggedIn && !isOnLoginPage) {
    return NextResponse.redirect(
      new URL(`${BASE_PATH}/login`, req.nextUrl.origin)
    );
  }

  // 認証済みユーザーがログインページにアクセスした場合、ダッシュボードにリダイレクト
  if (isLoggedIn && isOnLoginPage) {
    return NextResponse.redirect(
      new URL(`${BASE_PATH}/dashboard`, req.nextUrl.origin)
    );
  }

  return NextResponse.next();
}

/**
 * NextAuth のミドルウェアラッパー
 * AUTH_SKIP=1 の場合は authReq.auth が設定されていなくても true として扱う
 */
const authMiddleware = auth((authReq) => {
  // ランタイムで AUTH_SKIP を評価
  const isAuthSkip = process.env.AUTH_SKIP === '1';
  const isLoggedIn = isAuthSkip || !!authReq.auth;
  return handleAuth(isLoggedIn, authReq);
});

/**
 * Next.js Middleware
 *
 * NextAuth のミドルウェアラッパーを使用し、
 * AUTH_SKIP=1 の場合は常に認証済みとして扱う（ランタイム評価）
 */
export { authMiddleware as middleware };

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
