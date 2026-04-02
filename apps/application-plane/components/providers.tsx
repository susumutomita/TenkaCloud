/**
 * Providers Component
 *
 * アプリケーション全体のプロバイダー
 *
 * ## 通常モード
 * サーバー側で取得したセッションを SessionProvider に渡すことで、
 * クライアント側の初回 /api/auth/session 呼び出しを回避する。
 *
 * ## AUTH_SKIP モード
 * NextAuth v5 の SessionProvider を完全にバイパスし、SessionContext に
 * 静的なモックセッションを直接提供する。
 *
 * SessionProvider をバイパスする理由:
 * - NextAuth v5 SessionProvider は内部で `_getSession()` を呼び出し、
 *   `/api/auth/session` を fetch する。React Strict Mode の
 *   mount → cleanup（_session=undefined）→ remount フローにより、
 *   2回目のマウントで _session===undefined となり fetch が発生する。
 * - `_lastSync` は常に `now()` に設定され refetchInterval は加算されないため、
 *   staleness チェックは即座に stale と判定する。
 * - BroadcastChannel 経由の "storage" イベントが追加の fetch をトリガーし、
 *   結果として無限ポーリングループが発生する。
 * - refetchOnWindowFocus / refetchInterval / refetchWhenOffline の
 *   プロパティ制御では根本的に解決できない。
 *
 * SessionContext を直接提供することで、useSession() は正常に動作しつつ
 * `/api/auth/session` への fetch を完全に排除する。
 */

'use client';

import { useMemo } from 'react';
import { SessionProvider, SessionContext } from 'next-auth/react';
import type { Session } from 'next-auth';
import type { ReactNode } from 'react';

interface ProvidersProps {
  children: ReactNode;
  session?: Session | null;
  /** AUTH_SKIP モードフラグ（サーバーコンポーネントから渡される） */
  authSkip?: boolean;
}

/**
 * AUTH_SKIP モード用の静的セッションプロバイダー。
 * SessionContext に直接値を提供し、NextAuth の fetch ロジックをバイパスする。
 */
function AuthSkipProvider({
  children,
  session,
}: {
  children: ReactNode;
  session: Session | null;
}) {
  const value = useMemo(
    () => ({
      data: session,
      status: (session ? 'authenticated' : 'unauthenticated') as
        | 'authenticated'
        | 'unauthenticated',
      async update() {
        return session;
      },
    }),
    [session],
  );

  return (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SessionContext の内部型に合わせるため
    <SessionContext value={value as any}>{children}</SessionContext>
  );
}

export function Providers({ children, session, authSkip }: ProvidersProps) {
  if (authSkip) {
    return (
      <AuthSkipProvider session={session ?? null}>{children}</AuthSkipProvider>
    );
  }

  return <SessionProvider session={session}>{children}</SessionProvider>;
}
