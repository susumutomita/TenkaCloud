'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Cloud, Github, Mail } from 'lucide-react';

export default function SignupPage() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    confirmPassword: '',
    name: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validateForm = () => {
    const newErrors: Record<string, string> = {};

    if (!formData.name.trim()) {
      newErrors.name = '名前を入力してください';
    }

    if (!formData.email.trim()) {
      newErrors.email = 'メールアドレスを入力してください';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      newErrors.email = '有効なメールアドレスを入力してください';
    }

    if (!formData.password) {
      newErrors.password = 'パスワードを入力してください';
    } else if (formData.password.length < 8) {
      newErrors.password = 'パスワードは8文字以上で入力してください';
    }

    if (formData.password !== formData.confirmPassword) {
      newErrors.confirmPassword = 'パスワードが一致しません';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateForm()) return;

    setIsLoading(true);
    try {
      // TODO: 実際の API 呼び出しを実装
      // const response = await fetch('/api/auth/signup', {
      //   method: 'POST',
      //   headers: { 'Content-Type': 'application/json' },
      //   body: JSON.stringify(formData),
      // });

      // 仮実装: オンボーディングへ遷移
      await new Promise((resolve) => setTimeout(resolve, 1000));
      router.push('/onboarding');
    } catch {
      setErrors({ submit: 'サインアップに失敗しました。もう一度お試しください。' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleSocialLogin = (provider: 'google' | 'github') => {
    // TODO: ソーシャルログインの実装
    console.log(`Social login with ${provider}`);
  };

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

        {/* Social Login */}
        <div className="space-y-3">
          <Button
            variant="secondary"
            fullWidth
            onClick={() => handleSocialLogin('google')}
            type="button"
          >
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
          <Button
            variant="secondary"
            fullWidth
            onClick={() => handleSocialLogin('github')}
            type="button"
          >
            <Github className="w-5 h-5" />
            GitHub で続ける
          </Button>
        </div>

        {/* Divider */}
        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-border" />
          </div>
          <div className="relative flex justify-center text-sm">
            <span className="bg-surface-0 px-4 text-text-muted">または</span>
          </div>
        </div>

        {/* Email Signup Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="名前"
            type="text"
            placeholder="山田 太郎"
            value={formData.name}
            onChange={(e) =>
              setFormData({ ...formData, name: e.target.value })
            }
            error={errors.name}
            required
          />
          <Input
            label="メールアドレス"
            type="email"
            placeholder="you@example.com"
            value={formData.email}
            onChange={(e) =>
              setFormData({ ...formData, email: e.target.value })
            }
            error={errors.email}
            required
          />
          <Input
            label="パスワード"
            type="password"
            placeholder="8文字以上"
            value={formData.password}
            onChange={(e) =>
              setFormData({ ...formData, password: e.target.value })
            }
            error={errors.password}
            required
          />
          <Input
            label="パスワード（確認）"
            type="password"
            placeholder="パスワードを再入力"
            value={formData.confirmPassword}
            onChange={(e) =>
              setFormData({ ...formData, confirmPassword: e.target.value })
            }
            error={errors.confirmPassword}
            required
          />

          {errors.submit && (
            <div className="p-3 rounded-lg bg-hn-error/10 border border-hn-error/20 text-hn-error text-sm">
              {errors.submit}
            </div>
          )}

          <Button type="submit" fullWidth loading={isLoading}>
            <Mail className="w-4 h-4" />
            メールアドレスで登録
          </Button>
        </form>

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
