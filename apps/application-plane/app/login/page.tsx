import { loginWithAuth0 } from './actions';

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900">
      <div className="w-full max-w-md space-y-8 rounded-lg bg-slate-800 p-8 shadow-xl border border-slate-700">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-white">TenkaCloud</h1>
          <p className="mt-2 text-sm text-slate-400">
            クラウド天下一武道会 — 競技者ポータル
          </p>
        </div>

        <form action={loginWithAuth0}>
          <button
            type="submit"
            className="w-full rounded-md bg-emerald-600 px-4 py-2 text-white hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-800"
          >
            Auth0 でログイン
          </button>
        </form>

        <p className="text-center text-xs text-slate-500">
          ログイン後、バトルに参加して AWS Console にアクセスできます
        </p>
      </div>
    </div>
  );
}
