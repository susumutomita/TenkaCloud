import { signIn } from '@/auth';

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-100">
      <div className="w-full max-w-md space-y-8 rounded-lg bg-white p-8 shadow-md">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-gray-900">
            TenkaCloud Control Plane
          </h1>
          <p className="mt-2 text-sm text-gray-600">
            プラットフォーム管理者向けコンソール
          </p>
        </div>

        <form
          action={async () => {
            'use server';
            await signIn('keycloak', { redirectTo: '/dashboard' });
          }}
        >
          <button
            type="submit"
            className="w-full rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
          >
            Keycloak でログイン
          </button>
        </form>

        <p className="text-center text-xs text-gray-500">
          認証には Keycloak を使用します
        </p>
      </div>
    </div>
  );
}
