/**
 * テナント識別ロジック
 *
 * Application Plane でテナントを識別するためのユーティリティ
 * - 本番環境: サブドメインから識別（例: acme.tenka.cloud）
 * - 開発環境: クエリパラメータから識別（例: ?tenant=acme）
 */

import type { NextRequest } from 'next/server';

/**
 * 予約済みサブドメイン（テナントスラッグとして使用不可）
 */
const RESERVED_SUBDOMAINS = [
  'www',
  'api',
  'admin',
  'app',
  'staging',
  'production',
  'dev',
  'test',
  'demo',
  'status',
  'help',
  'support',
  'docs',
  'blog',
  'mail',
  'ftp',
  'cdn',
  'static',
  'assets',
];

/**
 * Application Plane のベースドメイン
 */
const BASE_DOMAIN = 'tenka.cloud';
const DEV_BASE_URL =
  process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:13001';

/**
 * サブドメインからテナントスラッグを取得
 *
 * 例: acme.tenka.cloud → "acme"
 */
export function getTenantSlugFromSubdomain(req: NextRequest): string | null {
  const hostname = req.nextUrl.hostname;

  // localhost や IP アドレスの場合はサブドメインなし
  if (hostname === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    return null;
  }

  // ドメインを分割
  const parts = hostname.split('.');

  // 最低限 subdomain.domain.tld の3パーツ必要
  if (parts.length < 3) {
    return null;
  }

  const subdomain = parts[0];

  // www は無視
  if (subdomain === 'www') {
    return null;
  }

  // 予約済みサブドメインは無効
  if (RESERVED_SUBDOMAINS.includes(subdomain)) {
    return null;
  }

  return subdomain;
}

/**
 * クエリパラメータからテナントスラッグを取得
 *
 * 例: ?tenant=acme → "acme"
 */
export function getTenantSlugFromQueryParam(req: NextRequest): string | null {
  const tenant = req.nextUrl.searchParams.get('tenant');
  return tenant || null;
}

/**
 * URL からテナントスラッグを取得（サブドメイン優先、フォールバックでクエリパラメータ）
 */
export function getTenantSlugFromUrl(req: NextRequest): string | null {
  // サブドメインを優先
  const fromSubdomain = getTenantSlugFromSubdomain(req);
  if (fromSubdomain) {
    return fromSubdomain;
  }

  // フォールバック: クエリパラメータ
  return getTenantSlugFromQueryParam(req);
}

/**
 * Application Plane の URL を構築
 *
 * @param tenantSlug テナントスラッグ
 * @param path パス（デフォルト: "/"）
 * @param isProduction 本番環境かどうか（デフォルト: 環境変数から判定）
 */
export function buildApplicationPlaneUrl(
  tenantSlug: string,
  path = '/',
  isProduction = process.env.NODE_ENV === 'production'
): string {
  if (isProduction) {
    // 本番: サブドメイン形式
    return `https://${tenantSlug}.${BASE_DOMAIN}${path}`;
  }

  // 開発: クエリパラメータ形式
  const separator = path.includes('?') ? '&' : '?';
  return `${DEV_BASE_URL}${path}${separator}tenant=${tenantSlug}`;
}

/**
 * テナントスラッグが有効かどうかを検証
 *
 * - 小文字英数字とハイフンのみ
 * - 先頭・末尾にハイフン不可
 * - 3〜63文字
 * - 予約語不可
 */
export function isValidTenantSlug(slug: string): boolean {
  // 空チェック
  if (!slug) {
    return false;
  }

  // 予約語チェック
  if (RESERVED_SUBDOMAINS.includes(slug.toLowerCase())) {
    return false;
  }

  // フォーマットチェック: 小文字英数字とハイフン、1〜63文字、先頭・末尾にハイフン不可
  // 正規表現で長さも検証: ^[a-z0-9] = 1文字 + ([a-z0-9-]{0,61}[a-z0-9])? = 0〜62文字 = 合計1〜63文字
  const pattern = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
  return pattern.test(slug);
}
