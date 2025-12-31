import { NextResponse } from 'next/server';
import { auth } from '@/auth';

export const middleware = auth((req) => {
  const isLoggedIn = !!req.auth;
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
});

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
