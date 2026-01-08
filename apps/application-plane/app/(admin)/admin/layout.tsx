/**
 * Admin Layout
 *
 * HybridNext Design System - Terminal Command Center style
 * Dark-themed admin layout with sidebar navigation
 */

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useTenantOptional } from '@/lib/tenant';
import type { ReactNode } from 'react';

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
}

const navItems: NavItem[] = [
  {
    href: '/admin',
    label: 'ダッシュボード',
    icon: (
      <svg
        className="w-5 h-5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"
        />
      </svg>
    ),
  },
  {
    href: '/admin/events',
    label: 'イベント管理',
    icon: (
      <svg
        className="w-5 h-5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
        />
      </svg>
    ),
  },
  {
    href: '/admin/participants',
    label: '参加者管理',
    icon: (
      <svg
        className="w-5 h-5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"
        />
      </svg>
    ),
  },
  {
    href: '/admin/teams',
    label: 'チーム管理',
    icon: (
      <svg
        className="w-5 h-5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
        />
      </svg>
    ),
  },
  {
    href: '/admin/settings',
    label: '設定',
    icon: (
      <svg
        className="w-5 h-5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
        />
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
        />
      </svg>
    ),
  },
];

interface AdminLayoutProps {
  children: ReactNode;
}

export default function AdminLayout({ children }: AdminLayoutProps) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const tenant = useTenantOptional();

  const isActive = (href: string) => {
    if (href === '/admin') {
      return pathname === '/admin';
    }
    return pathname.startsWith(href);
  };

  return (
    <div className="min-h-screen bg-surface-0">
      {/* Top Header */}
      <header className="bg-surface-1 border-b border-border fixed top-0 left-0 right-0 z-[var(--z-sticky)]">
        <div className="flex items-center justify-between h-16 px-4">
          <div className="flex items-center space-x-4">
            <Link href="/admin" className="flex items-center space-x-2 group">
              <span className="text-2xl">⚔️</span>
              <span className="font-bold text-xl text-text-primary group-hover:text-hn-accent transition-colors">
                TenkaCloud
              </span>
              <span className="text-sm font-mono text-text-muted border-l border-border pl-4 ml-2">
                [ADMIN]
              </span>
            </Link>
          </div>

          <div className="flex items-center space-x-4">
            {tenant?.slug && (
              <span className="text-sm font-mono text-hn-accent bg-hn-accent/10 px-3 py-1 rounded-[var(--radius)] border border-hn-accent/30">
                {tenant.slug}
              </span>
            )}
            <Link
              href="/dashboard"
              className="text-sm text-text-secondary hover:text-hn-accent transition-colors"
            >
              参加者画面へ →
            </Link>
            <div className="flex items-center space-x-2">
              <div className="w-8 h-8 bg-hn-accent rounded-[var(--radius)] flex items-center justify-center text-surface-0 font-semibold shadow-[2px_2px_0_var(--color-hn-accent-dim)]">
                {session?.user?.name?.charAt(0).toUpperCase() || 'A'}
              </div>
              <span className="text-sm font-medium text-text-primary">
                {session?.user?.name || '管理者'}
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* Sidebar */}
      <aside className="fixed left-0 top-16 bottom-0 w-64 bg-surface-1 border-r border-border overflow-y-auto">
        <nav className="p-4 space-y-1">
          {navItems.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center space-x-3 px-3 py-2.5 rounded-[var(--radius)] transition-all duration-[var(--animation-duration-fast)] ${
                  active
                    ? 'bg-hn-accent text-surface-0 shadow-[2px_2px_0_var(--color-hn-accent-dim)]'
                    : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary'
                }`}
              >
                <span className={active ? 'text-surface-0' : 'text-text-muted'}>
                  {item.icon}
                </span>
                <span className="font-medium">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Terminal-style footer */}
        <div className="absolute bottom-0 left-0 right-0 p-4 border-t border-border bg-surface-2">
          <div className="text-xs font-mono text-text-muted">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-hn-success animate-pulse" />
              <span>システム稼働中</span>
            </div>
            <div className="mt-1 text-text-muted/60">v0.1.0-alpha</div>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="ml-64 pt-16">
        <div className="p-8">{children}</div>
      </main>
    </div>
  );
}
