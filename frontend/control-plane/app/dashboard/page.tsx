import { redirect } from 'next/navigation';
import { auth, signOut } from '@/auth';

export default async function DashboardPage() {
  const session = await auth();

  if (!session?.user) {
    redirect('/login');
  }

  return (
    <div className="min-h-screen bg-gray-100 p-8">
      <div className="mx-auto max-w-7xl">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">
              Control Plane Dashboard
            </h1>
            <p className="mt-2 text-sm text-gray-600">
              ようこそ、{session.user.name || session.user.email} さん
            </p>
          </div>

          <form
            action={async () => {
              'use server';
              const currentSession = await auth();
              await signOut({ redirect: false });

              if (currentSession?.idToken && process.env.AUTH_KEYCLOAK_ISSUER) {
                const logoutUrl = `${process.env.AUTH_KEYCLOAK_ISSUER}/protocol/openid-connect/logout?post_logout_redirect_uri=${encodeURIComponent(
                  'http://localhost:3000'
                )}&id_token_hint=${currentSession.idToken}`;
                redirect(logoutUrl);
              } else {
                redirect('/login');
              }
            }}
          >
            <button
              type="submit"
              className="rounded-md bg-red-600 px-4 py-2 text-white hover:bg-red-700"
            >
              ログアウト
            </button>
          </form>
        </div>

        <div className="grid gap-6 md:grid-cols-3">
          <div className="rounded-lg bg-white p-6 shadow">
            <h2 className="text-lg font-semibold text-gray-900">
              アクティブテナント
            </h2>
            <p className="mt-2 text-3xl font-bold text-blue-600">0</p>
            <p className="mt-1 text-sm text-gray-500">現在のテナント数</p>
          </div>

          <div className="rounded-lg bg-white p-6 shadow">
            <h2 className="text-lg font-semibold text-gray-900">
              実行中のバトル
            </h2>
            <p className="mt-2 text-3xl font-bold text-green-600">0</p>
            <p className="mt-1 text-sm text-gray-500">現在のバトル数</p>
          </div>

          <div className="rounded-lg bg-white p-6 shadow">
            <h2 className="text-lg font-semibold text-gray-900">
              システムステータス
            </h2>
            <p className="mt-2 text-xl font-bold text-green-600">正常</p>
            <p className="mt-1 text-sm text-gray-500">全サービス稼働中</p>
          </div>
        </div>

        <div className="mt-8 rounded-lg bg-white p-6 shadow">
          <h2 className="text-lg font-semibold text-gray-900">
            セッション情報
          </h2>
          <pre className="mt-4 overflow-auto rounded bg-gray-100 p-4 text-sm">
            {JSON.stringify(session, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
}
