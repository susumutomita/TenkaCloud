/**
 * PageLayout
 *
 * 全参加者ページ共通テンプレート — Cloudscape product-detail パターン
 *
 * header を渡すと ContentLayout でラップされ、AWS コンソール風の
 * ヘッダー背景（product-detail-page パターン）が有効になります。
 *
 * 使用例（シンプル）:
 *   <PageLayout>
 *     <Header variant="h1">タイトル</Header>
 *     ...コンテンツ...
 *   </PageLayout>
 *
 * 使用例（product-detail パターン）:
 *   <PageLayout
 *     header={<Header variant="h1" actions={<Button>操作</Button>}>タイトル</Header>}
 *     breadcrumbs={[{ text: 'ホーム', href: '/' }, { text: 'イベント', href: '/events' }, { text: 'イベント名' }]}
 *   >
 *     ...コンテンツ...
 *   </PageLayout>
 */

'use client';

import BreadcrumbGroup from '@cloudscape-design/components/breadcrumb-group';
import SpaceBetween from '@cloudscape-design/components/space-between';
import TopNavigation from '@cloudscape-design/components/top-navigation';
import '@cloudscape-design/global-styles/index.css';
import { useRouter } from 'next/navigation';
import { signOut } from 'next-auth/react';
import { useSession } from 'next-auth/react';
import { type ReactNode, useEffect, useState } from 'react';

export interface BreadcrumbItem {
  text: string;
  href?: string;
}

type MaxWidth = '3xl' | '4xl' | '5xl' | '6xl' | '7xl';

const maxWidthClass: Record<MaxWidth, string> = {
  '3xl': 'max-w-3xl',
  '4xl': 'max-w-4xl',
  '5xl': 'max-w-5xl',
  '6xl': 'max-w-6xl',
  '7xl': 'max-w-7xl',
};

interface PageLayoutProps {
  children: ReactNode;
  /**
   * ContentLayout のヘッダーセクション（product-detail パターン）。
   * 渡すと AWS コンソール風のヘッダー背景が表示される。
   */
  header?: ReactNode;
  /** パンくずリスト（header と合わせて使用） */
  breadcrumbs?: BreadcrumbItem[];
  /** コンテンツ最大幅（デフォルト: 7xl）。header なしの場合のみ有効 */
  maxWidth?: MaxWidth;
}

export function PageLayout({
  children,
  header,
  breadcrumbs,
  maxWidth = '7xl',
}: PageLayoutProps) {
  const router = useRouter();
  const { data: session } = useSession();
  const [mounted, setMounted] = useState(false);
  const widthClass = maxWidthClass[maxWidth];

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <div className="min-h-screen bg-surface-0">
      <div className="awsui-dark-mode">
        {mounted && (
          <div id="participant-top-nav">
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
                  type: 'button' as const,
                  text: 'ダッシュボード',
                  href: '/dashboard',
                },
                {
                  type: 'button' as const,
                  text: 'イベント',
                  href: '/events',
                },
                {
                  type: 'button' as const,
                  text: 'ランキング',
                  href: '/rankings',
                },
                ...(session
                  ? [
                      ...(session.roles?.includes('admin')
                        ? [
                            {
                              type: 'button' as const,
                              text: '管理ダッシュボード',
                              href: '/admin',
                            },
                          ]
                        : []),
                      {
                        type: 'menu-dropdown' as const,
                        text: session.user?.name || 'ユーザー',
                        iconName: 'user-profile' as const,
                        items: [
                          { id: 'profile', text: 'プロフィール' },
                          { id: 'signout', text: 'ログアウト' },
                        ],
                        onItemClick: ({
                          detail,
                        }: {
                          detail: { id: string };
                        }) => {
                          if (detail.id === 'signout') {
                            signOut({ callbackUrl: '/login' });
                          }
                          if (detail.id === 'profile') {
                            router.push('/profile');
                          }
                        },
                      },
                    ]
                  : [
                      {
                        type: 'button' as const,
                        text: 'ログイン',
                        href: '/login',
                      },
                    ]),
              ]}
              i18nStrings={{
                overflowMenuTriggerText: 'その他',
                overflowMenuTitleText: 'すべて',
              }}
            />
          </div>
        )}
        {breadcrumbs && breadcrumbs.length > 0 && (
          <div className={`${widthClass} mx-auto px-4 sm:px-6 lg:px-8 pt-4`}>
            <BreadcrumbGroup
              items={breadcrumbs.map((item) => ({
                text: item.text,
                href: item.href ?? '#',
              }))}
              onFollow={(e) => {
                e.preventDefault();
                if (e.detail.href && e.detail.href !== '#') {
                  router.push(e.detail.href);
                }
              }}
              ariaLabel="パンくずリスト"
            />
          </div>
        )}
        <div className={`${widthClass} mx-auto px-4 sm:px-6 lg:px-8 py-8`}>
          <SpaceBetween size="l">
            {header}
            {children}
          </SpaceBetween>
        </div>
      </div>
    </div>
  );
}
