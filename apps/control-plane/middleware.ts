import { type NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';

const authSkipEnabled = process.env.AUTH_SKIP === '1';

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
    return NextResponse.redirect(new URL('/login', req.nextUrl.origin));
  }

  // 認証済みユーザーがログインページにアクセスした場合、ダッシュボードにリダイレクト
  if (isLoggedIn && isOnLoginPage) {
    return NextResponse.redirect(new URL('/dashboard', req.nextUrl.origin));
  }

  return NextResponse.next();
}

/**
 * Next.js Middleware
 *
 * AUTH_SKIP=1 の場合は常に認証済みとして扱う
 * それ以外は NextAuth のミドルウェアラッパーを使用
 */
export const middleware = authSkipEnabled
  ? (req: NextRequest) => handleAuth(true, req)
  : auth((req) => handleAuth(!!req.auth, req));

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
