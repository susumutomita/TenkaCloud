'use client';

import { motion } from 'framer-motion';
import { ArrowLeft, Github, Mail } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useRouter } from 'next/navigation';

const signupSchema = z
  .object({
    email: z.string().email('有効なメールアドレスを入力してください'),
    password: z
      .string()
      .min(8, 'パスワードは8文字以上必要です')
      .regex(
        /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,
        'パスワードは大文字、小文字、数字を含む必要があります'
      ),
    confirmPassword: z.string(),
    acceptTerms: z.boolean().refine((val) => val === true, {
      message: '利用規約に同意する必要があります',
    }),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'パスワードが一致しません',
    path: ['confirmPassword'],
  });

type SignupFormData = z.infer<typeof signupSchema>;

export default function SignupPage() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SignupFormData>({
    resolver: zodResolver(signupSchema),
  });

  const onSubmit = async (data: SignupFormData) => {
    setIsLoading(true);
    try {
      const response = await fetch('http://localhost:3004/api/signup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: data.email,
          password: data.password,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Signup failed');
      }

      const result = await response.json();
      console.log('Signup success:', result);

      // Redirect to onboarding
      router.push('/onboarding');
    } catch (error) {
      console.error('Signup failed:', error);
      // Here you might want to set a form error using setError from react-hook-form
      // For now, we'll just log it. Ideally, show a toast or alert.
      alert(error instanceof Error ? error.message : 'Signup failed');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      {/* Background gradient orbs */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div
          className="absolute top-1/4 left-1/4 w-96 h-96 rounded-full opacity-10 blur-3xl animate-float"
          style={{ background: 'oklch(0.56 0.20 264)' }}
        />
        <div
          className="absolute bottom-1/4 right-1/4 w-96 h-96 rounded-full opacity-10 blur-3xl animate-float"
          style={{ background: 'oklch(0.56 0.20 180)', animationDelay: '-3s' }}
        />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative w-full max-w-md"
      >
        {/* Back link */}
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-white/60 hover:text-white/90 transition-colors mb-8"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>ホームに戻る</span>
        </Link>

        {/* Card */}
        <div className="glass rounded-3xl p-8 shadow-2xl">
          <div className="space-y-6">
            {/* Header */}
            <div className="text-center space-y-2">
              <h1 className="text-3xl font-bold gradient-text">
                アカウント作成
              </h1>
              <p className="text-white/60">
                無料で始める - クレジットカード不要
              </p>
            </div>

            {/* Social login buttons */}
            <div className="space-y-3">
              <button
                type="button"
                className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-white/10 hover:bg-white/15 rounded-xl transition-colors"
              >
                <Mail className="w-5 h-5" />
                <span>Google でサインアップ</span>
              </button>

              <button
                type="button"
                className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-white/10 hover:bg-white/15 rounded-xl transition-colors"
              >
                <Github className="w-5 h-5" />
                <span>GitHub でサインアップ</span>
              </button>
            </div>

            {/* Divider */}
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-white/10" />
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="px-4 bg-transparent text-white/60">
                  または
                </span>
              </div>
            </div>

            {/* Form */}
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <div>
                <label
                  htmlFor="email"
                  className="block text-sm font-medium text-white/80 mb-2"
                >
                  メールアドレス
                </label>
                <input
                  id="email"
                  type="email"
                  {...register('email')}
                  className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl focus:outline-none focus:border-primary-500 transition-colors"
                  placeholder="you@example.com"
                />
                {errors.email && (
                  <p className="mt-1 text-sm text-red-400">
                    {errors.email.message}
                  </p>
                )}
              </div>

              <div>
                <label
                  htmlFor="password"
                  className="block text-sm font-medium text-white/80 mb-2"
                >
                  パスワード
                </label>
                <input
                  id="password"
                  type="password"
                  {...register('password')}
                  className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl focus:outline-none focus:border-primary-500 transition-colors"
                  placeholder="••••••••"
                />
                {errors.password && (
                  <p className="mt-1 text-sm text-red-400">
                    {errors.password.message}
                  </p>
                )}
              </div>

              <div>
                <label
                  htmlFor="confirmPassword"
                  className="block text-sm font-medium text-white/80 mb-2"
                >
                  パスワード（確認）
                </label>
                <input
                  id="confirmPassword"
                  type="password"
                  {...register('confirmPassword')}
                  className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl focus:outline-none focus:border-primary-500 transition-colors"
                  placeholder="••••••••"
                />
                {errors.confirmPassword && (
                  <p className="mt-1 text-sm text-red-400">
                    {errors.confirmPassword.message}
                  </p>
                )}
              </div>

              <div className="flex items-start gap-3">
                <input
                  id="acceptTerms"
                  type="checkbox"
                  {...register('acceptTerms')}
                  className="mt-1 w-4 h-4 rounded border-white/20 bg-white/5 focus:ring-primary-500"
                />
                <label htmlFor="acceptTerms" className="text-sm text-white/70">
                  <Link
                    href="/terms"
                    className="text-primary-400 hover:text-primary-300"
                  >
                    利用規約
                  </Link>{' '}
                  と{' '}
                  <Link
                    href="/privacy"
                    className="text-primary-400 hover:text-primary-300"
                  >
                    プライバシーポリシー
                  </Link>{' '}
                  に同意します
                </label>
              </div>
              {errors.acceptTerms && (
                <p className="text-sm text-red-400">
                  {errors.acceptTerms.message}
                </p>
              )}

              <button
                type="submit"
                disabled={isLoading}
                className="w-full px-6 py-3 bg-gradient-to-r from-primary-500 to-accent-500 rounded-xl font-semibold shadow-lg shadow-primary-500/25 hover:shadow-primary-500/40 transition-shadow disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? '作成中...' : 'アカウントを作成'}
              </button>
            </form>

            {/* Login link */}
            <p className="text-center text-sm text-white/60">
              すでにアカウントをお持ちですか？{' '}
              <Link
                href="/login"
                className="text-primary-400 hover:text-primary-300"
              >
                ログイン
              </Link>
            </p>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
