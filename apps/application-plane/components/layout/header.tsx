/**
 * Header Component
 *
 * アプリケーションヘッダー
 */

'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useSession, signOut } from 'next-auth/react';
import { useTenantOptional } from '@/lib/tenant';

export function Header() {
  const { data: session, status } = useSession();
  const tenant = useTenantOptional();
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const userName = session?.user?.name;
  const isLoading = status === 'loading';

  return (
    <header className="bg-surface-1 border-b border-border sticky top-0 z-50 backdrop-blur-sm bg-opacity-95">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          {/* Logo */}
          <Link href="/dashboard" className="flex items-center space-x-2">
            <div className="w-8 h-8 bg-hn-accent rounded-lg flex items-center justify-center shadow-brutal-sm">
              <span className="text-surface-0 font-black text-lg">T</span>
            </div>
            <span className="font-bold text-xl text-text-primary">
              TenkaCloud
            </span>
          </Link>

          {/* Navigation */}
          <nav className="hidden md:flex items-center space-x-8">
            <Link
              href="/dashboard"
              className="text-text-secondary hover:text-text-primary font-medium transition-colors"
            >
              ダッシュボード
            </Link>
            <Link
              href="/events"
              className="text-text-secondary hover:text-text-primary font-medium transition-colors"
            >
              イベント
            </Link>
            <Link
              href="/rankings"
              className="text-text-secondary hover:text-text-primary font-medium transition-colors"
            >
              ランキング
            </Link>
          </nav>

          {/* User Menu */}
          <div className="flex items-center space-x-4">
            {isLoading ? (
              <div className="w-8 h-8 bg-surface-2 rounded-full animate-pulse" />
            ) : session ? (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setIsMenuOpen(!isMenuOpen)}
                  className="flex items-center space-x-2 text-text-secondary hover:text-text-primary transition-colors"
                  aria-expanded={isMenuOpen}
                  aria-haspopup="true"
                >
                  <div className="w-8 h-8 bg-hn-accent rounded-full flex items-center justify-center text-surface-0 font-medium">
                    {userName ? userName.charAt(0).toUpperCase() : 'U'}
                  </div>
                  <span className="hidden sm:block font-medium">
                    {userName || 'ユーザー'}
                  </span>
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 9l-7 7-7-7"
                    />
                  </svg>
                </button>

                {isMenuOpen && (
                  <div className="absolute right-0 mt-2 w-48 bg-surface-elevated rounded-lg shadow-lg py-1 border border-border">
                    <Link
                      href="/profile"
                      className="block px-4 py-2 text-sm text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors"
                      onClick={() => setIsMenuOpen(false)}
                    >
                      プロフィール
                    </Link>
                    <Link
                      href="/profile/history"
                      className="block px-4 py-2 text-sm text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors"
                      onClick={() => setIsMenuOpen(false)}
                    >
                      参加履歴
                    </Link>
                    <Link
                      href="/profile/badges"
                      className="block px-4 py-2 text-sm text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors"
                      onClick={() => setIsMenuOpen(false)}
                    >
                      バッジ
                    </Link>
                    <hr className="my-1 border-border" />
                    <button
                      type="button"
                      className="block w-full text-left px-4 py-2 text-sm text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors"
                      onClick={() => {
                        setIsMenuOpen(false);
                        signOut({ callbackUrl: '/login' });
                      }}
                    >
                      ログアウト
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <Link
                href="/login"
                className="bg-hn-accent text-surface-0 px-4 py-2 rounded-lg font-medium hover:bg-hn-accent-bright transition-colors shadow-brutal-sm"
              >
                ログイン
              </Link>
            )}

            {/* Mobile Menu Button */}
            <button
              type="button"
              className="md:hidden p-2 text-text-secondary hover:text-text-primary transition-colors"
              onClick={() => setIsMenuOpen(!isMenuOpen)}
              aria-label="メニューを開く"
            >
              <svg
                className="w-6 h-6"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <title>メニュー</title>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 6h16M4 12h16M4 18h16"
                />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
