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
import type { ReactNode } from 'react';

const navItems: SideNavigationProps.Item[] = [
  { type: 'link', text: 'ダッシュボード', href: '/dashboard' },
  { type: 'link', text: 'テナント管理', href: '/dashboard/tenants' },
  { type: 'link', text: '設定', href: '/dashboard/settings' },
];

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  const activeHref = navItems
    .filter((item): item is SideNavigationProps.Link => item.type === 'link')
    .find((item) => {
      if (item.href === '/dashboard') return pathname === '/dashboard';
      return pathname.startsWith(item.href);
    })?.href;

  return (
    <div className="awsui-dark-mode">
      <div id="cp-top-nav">
        <TopNavigation
          identity={{
            href: '/dashboard',
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
            header={{ text: 'Control Plane', href: '/dashboard' }}
            activeHref={activeHref}
            items={navItems}
            onFollow={(e) => {
              e.preventDefault();
              router.push(e.detail.href);
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
