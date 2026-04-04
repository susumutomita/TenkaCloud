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
import ContentLayout from '@cloudscape-design/components/content-layout';
import SpaceBetween from '@cloudscape-design/components/space-between';
import '@cloudscape-design/global-styles/index.css';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { Header } from './header';

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
  const widthClass = maxWidthClass[maxWidth];

  return (
    <div className="min-h-screen bg-surface-0">
      <Header />
      <div className="awsui-dark-mode">
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
        {header ? (
          <ContentLayout header={header}>
            <div className={`${widthClass} mx-auto px-4 sm:px-6 lg:px-8 pb-8`}>
              <SpaceBetween size="l">{children}</SpaceBetween>
            </div>
          </ContentLayout>
        ) : (
          <div className={`${widthClass} mx-auto px-4 sm:px-6 lg:px-8 py-8`}>
            <SpaceBetween size="l">{children}</SpaceBetween>
          </div>
        )}
      </div>
    </div>
  );
}
