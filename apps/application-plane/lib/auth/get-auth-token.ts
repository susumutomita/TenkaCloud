/**
 * 認証トークン取得ユーティリティ
 *
 * AUTH_SKIP モードではモックトークンを直接返し、
 * `getSession()` による `/api/auth/session` への HTTP フェッチを回避する。
 *
 * ## なぜ getSession() をバイパスするのか
 *
 * NextAuth v5 の `getSession()` は `SessionContext` を参照せず、
 * 常に `/api/auth/session` への HTTP リクエストを発行する。
 * GameDay のポーリング（15秒間隔）で毎回呼ばれるため、
 * AUTH_SKIP モードでは不要なネットワークリクエストが大量に発生する。
 *
 * `NEXT_PUBLIC_AUTH_SKIP` 環境変数をクライアントサイドで参照し、
 * モックトークンを即座に返すことでこの問題を解決する。
 */

import { getSession } from 'next-auth/react';

/** AUTH_SKIP モードで使用するモックアクセストークン（auth.ts の mockSession と一致） */
const MOCK_ACCESS_TOKEN = 'mock-access-token';

/**
 * 認証トークンを取得
 *
 * AUTH_SKIP モード: `NEXT_PUBLIC_AUTH_SKIP=1` の場合、HTTP リクエストなしでモックトークンを返す
 * 通常モード: `getSession()` で NextAuth セッションからアクセストークンを取得
 */
export async function getAuthToken(): Promise<string | null> {
  if (process.env.NEXT_PUBLIC_AUTH_SKIP === '1') {
    return MOCK_ACCESS_TOKEN;
  }
  const session = await getSession();
  return session?.accessToken ?? null;
}
