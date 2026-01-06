/**
 * Application Plane Middleware
 *
 * - テナント識別（本番: サブドメイン、開発: クエリパラメータ）
 * - 認証チェック（NextAuth.js + Auth0）
 * - ロールベースルーティング（admin / participant）
 */

import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/auth';
import {
  getTenantSlugFromUrl,
  buildApplicationPlaneUrl,
} from '@/lib/tenant/identification';

/**
 * 公開パス（認証不要）
 */
const PUBLIC_PATHS = [
  '/login',
  '/api/auth',
  '/_next',
  '/favicon.ico',
  '/public',
];

/**
 * パスが公開パスかどうかを判定
 */
function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`)
  );
}

/**
 * 管理者パスかどうかを判定
 */
function isAdminPath(pathname: string): boolean {
  return pathname === '/admin' || pathname.startsWith('/admin/');
}

/**
 * 認証処理を行うハンドラー
 */
async function handleAuth(
  isAuthenticated: boolean,
  roles: string[],
  sessionTenantId: string | null | undefined,
  urlTenantSlug: string | null,
  req: NextRequest
): Promise<NextResponse> {
  const { pathname, search } = req.nextUrl;

  // 公開パスは認証不要
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // 未認証 → /login へリダイレクト
  if (!isAuthenticated) {
    const loginUrl = new URL('/login', req.url);
    loginUrl.searchParams.set('callbackUrl', `${pathname}${search}`);
    return NextResponse.redirect(loginUrl);
  }

  // 管理者パスへのアクセス権限チェック
  if (isAdminPath(pathname)) {
    const hasAdminRole = roles.includes('admin');
    if (!hasAdminRole) {
      // 権限なし → /dashboard へリダイレクト
      const dashboardUrl = new URL('/dashboard', req.url);
      return NextResponse.redirect(dashboardUrl);
    }
  }

  // テナント識別とヘッダー設定
  // URL から取得したテナントスラッグを使用（セッションより優先）
  const tenantSlug = urlTenantSlug || sessionTenantId || null;

  // レスポンスヘッダーにテナント情報を設定（サーバーコンポーネントで使用可能）
  const response = NextResponse.next();
  if (tenantSlug) {
    response.headers.set('x-tenant-slug', tenantSlug);
  }

  return response;
}

/**
 * Middleware エントリーポイント
 */
export async function middleware(req: NextRequest): Promise<NextResponse> {
  // テナントスラッグを URL から取得
  const urlTenantSlug = getTenantSlugFromUrl(req);

  // セッションを取得して認証チェック
  const session = await auth();

  const isAuthenticated = !!session;
  const roles = session?.roles || [];
  const sessionTenantId = session?.tenantId;

  return handleAuth(
    isAuthenticated,
    roles,
    sessionTenantId,
    urlTenantSlug,
    req
  );
}

/**
 * Middleware が適用されるパスの設定
 */
export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder
     */
    '/((?!_next/static|_next/image|favicon.ico|public/).*)',
  ],
};
