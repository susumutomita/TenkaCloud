import Link from 'next/link';
import { Cloud, Github, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { signupWithAuth0 } from './actions';

export default function SignupPage() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md space-y-8">
        {/* Header */}
        <div className="text-center">
          <Link href="/" className="inline-flex items-center gap-2 mb-6">
            <Cloud className="w-8 h-8 text-hn-accent" />
            <span className="font-display text-2xl font-bold text-text-primary">
              TenkaCloud
            </span>
          </Link>
          <h1 className="font-display text-3xl font-bold text-text-primary">
            アカウント作成
          </h1>
          <p className="mt-2 text-text-muted">
            クラウド天下一武道会に参加しよう
          </p>
        </div>

        {/* Auth0 Signup */}
        <form action={signupWithAuth0} className="space-y-4">
          <Button type="submit" fullWidth>
            <Mail className="w-4 h-4" />
            メールアドレスで登録
          </Button>
        </form>

        {/* Divider */}
        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-border" />
          </div>
          <div className="relative flex justify-center text-sm">
            <span className="bg-surface-0 px-4 text-text-muted">または</span>
          </div>
        </div>

        {/* Social Login via Auth0 */}
        <div className="space-y-3">
          <form action={signupWithAuth0}>
            <Button variant="secondary" fullWidth type="submit">
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path
                  fill="currentColor"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="currentColor"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="currentColor"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                />
                <path
                  fill="currentColor"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                />
              </svg>
              Google で続ける
            </Button>
          </form>
          <form action={signupWithAuth0}>
            <Button variant="secondary" fullWidth type="submit">
              <Github className="w-5 h-5" />
              GitHub で続ける
            </Button>
          </form>
        </div>

        {/* Footer */}
        <p className="text-center text-sm text-text-muted">
          すでにアカウントをお持ちですか？{' '}
          <Link
            href="/login"
            className="text-hn-accent hover:text-hn-accent-bright font-medium"
          >
            ログイン
          </Link>
        </p>

        <p className="text-center text-xs text-text-muted">
          登録することで、
          <Link href="/terms" className="underline hover:text-text-secondary">
            利用規約
          </Link>
          と
          <Link href="/privacy" className="underline hover:text-text-secondary">
            プライバシーポリシー
          </Link>
          に同意したものとみなされます。
        </p>
      </div>
    </div>
  );
}
