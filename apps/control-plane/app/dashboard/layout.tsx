/**
 * Dashboard Layout
 *
 * Cloudscape Design System — AppLayout + SideNavigation
 */

'use client';

import AppLayout from '@cloudscape-design/components/app-layout';
import SideNavigation from '@cloudscape-design/components/side-navigation';
import type { SideNavigationProps } from '@cloudscape-design/components/side-navigation';
import TopNavigation from '@cloudscape-design/components/top-navigation';
import '@cloudscape-design/global-styles/index.css';
import { usePathname, useRouter } from 'next/navigation';
import { signOut } from 'next-auth/react';
import { type ReactNode, useEffect, useState } from 'react';
import { stripControlBasePath, withControlBasePath } from '@/lib/base-path';

const navItems: Array<SideNavigationProps.Link & { appPath: string }> = [
  {
    type: 'link',
    text: 'ダッシュボード',
    href: withControlBasePath('/dashboard'),
    appPath: '/dashboard',
  },
  {
    type: 'link',
    text: 'テナント管理',
    href: withControlBasePath('/dashboard/tenants'),
    appPath: '/dashboard/tenants',
  },
  {
    type: 'link',
    text: '設定',
    href: withControlBasePath('/dashboard/settings'),
    appPath: '/dashboard/settings',
  },
];

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const normalizedPath = stripControlBasePath(pathname);

  useEffect(() => {
    setMounted(true);
  }, []);

  const activeHref = navItems.find((item) => {
    if (item.appPath === '/dashboard') {
      return normalizedPath === '/dashboard';
    }

    return (
      normalizedPath === item.appPath ||
      normalizedPath.startsWith(`${item.appPath}/`)
    );
  })?.href;

  // Cloudscape は SSR で異なる内部 ID を生成するため、CSR のみでレンダリング
  if (!mounted) {
    return <div style={{ minHeight: '100vh' }}>{children}</div>;
  }

  return (
    <div>
      <div id="cp-top-nav">
        <TopNavigation
          identity={{
            href: withControlBasePath('/dashboard'),
            title: 'TenkaCloud',
            onFollow: (e) => {
              e.preventDefault();
              router.push('/dashboard');
            },
          }}
          utilities={[
            {
              type: 'menu-dropdown' as const,
              text: '管理者',
              iconName: 'user-profile' as const,
              items: [
                { id: 'settings', text: '設定' },
                {
                  id: 'signout',
                  text: 'ログアウト',
                },
              ],
              onItemClick: ({ detail }) => {
                if (detail.id === 'settings') {
                  router.push('/dashboard/settings');
                  return;
                }
                if (detail.id === 'signout') {
                  signOut({ callbackUrl: '/login' });
                }
              },
            },
          ]}
          i18nStrings={{
            overflowMenuTriggerText: 'その他',
            overflowMenuTitleText: 'すべて',
          }}
        />
      </div>
      <AppLayout
        navigation={
          <SideNavigation
            header={{
              text: 'Control Plane',
              href: withControlBasePath('/dashboard'),
            }}
            activeHref={activeHref}
            items={navItems}
            onFollow={(e) => {
              e.preventDefault();
              router.push(stripControlBasePath(e.detail.href));
            }}
          />
        }
        toolsHide
        content={<main>{children}</main>}
        headerSelector="#cp-top-nav"
        ariaLabels={{
          navigation: '管理メニュー',
          navigationClose: 'ナビゲーションを閉じる',
          navigationToggle: 'ナビゲーションを開く',
        }}
      />
    </div>
  );
}
