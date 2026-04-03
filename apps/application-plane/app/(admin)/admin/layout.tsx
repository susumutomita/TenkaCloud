/**
 * Admin Layout
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
import { useSession } from 'next-auth/react';
import { useTenantOptional } from '@/lib/tenant';
import type { ReactNode } from 'react';

const navItems: SideNavigationProps.Item[] = [
  { type: 'link', text: 'ダッシュボード', href: '/admin' },
  { type: 'link', text: 'イベント管理', href: '/admin/events' },
  { type: 'link', text: 'マーケットプレイス', href: '/admin/marketplace' },
  { type: 'link', text: '参加者管理', href: '/admin/participants' },
  { type: 'link', text: 'チーム管理', href: '/admin/teams' },
  { type: 'link', text: '分析', href: '/admin/analytics' },
  { type: 'divider' },
  { type: 'link', text: 'GameDay管理', href: '/admin/gameday' },
  { type: 'link', text: '設定', href: '/admin/settings' },
];

interface AdminLayoutProps {
  children: ReactNode;
}

export default function AdminLayout({ children }: AdminLayoutProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session } = useSession();
  const tenant = useTenantOptional();

  const activeHref = navItems
    .filter((item): item is SideNavigationProps.Link => item.type === 'link')
    .find((item) => {
      if (item.href === '/admin') return pathname === '/admin';
      return pathname.startsWith(item.href);
    })?.href;

  return (
    <div className="awsui-dark-mode">
      <div id="admin-top-nav">
        <TopNavigation
          identity={{
            href: '/admin',
            title: 'TenkaCloud',
            onFollow: (e) => {
              e.preventDefault();
              router.push('/admin');
            },
          }}
          utilities={[
            ...(tenant?.slug
              ? [
                  {
                    type: 'button' as const,
                    text: tenant.slug,
                    disableUtilityCollapse: true,
                  },
                ]
              : []),
            {
              type: 'button' as const,
              text: '参加者画面へ',
              href: '/dashboard',
              variant: 'link' as const,
            },
            {
              type: 'menu-dropdown' as const,
              text: session?.user?.name || '管理者',
              iconName: 'user-profile' as const,
              items: [
                { id: 'settings', text: '設定' },
                { id: 'signout', text: 'サインアウト' },
              ],
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
            header={{ text: 'ADMIN', href: '/admin' }}
            activeHref={activeHref}
            items={navItems}
            onFollow={(e) => {
              e.preventDefault();
              router.push(e.detail.href);
            }}
          />
        }
        toolsHide
        content={children}
        headerSelector="#admin-top-nav"
        ariaLabels={{
          navigation: '管理メニュー',
          navigationClose: 'ナビゲーションを閉じる',
          navigationToggle: 'ナビゲーションを開く',
        }}
      />
    </div>
  );
}
