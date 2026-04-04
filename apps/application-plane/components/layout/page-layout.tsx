/**
 * PageLayout
 *
 * 全参加者ページ共通テンプレート:
 *   AppHeader → <main> (max-w-7xl, パディング統一) → awsui-dark-mode ラッパー
 *
 * 使用例:
 *   <PageLayout>
 *     <Header variant="h1">ページタイトル</Header>
 *     ...Cloudscape コンテンツ...
 *   </PageLayout>
 *
 *   <PageLayout maxWidth="3xl">  // 幅を変える場合
 *     ...
 *   </PageLayout>
 */

'use client';

import SpaceBetween from '@cloudscape-design/components/space-between';
import '@cloudscape-design/global-styles/index.css';
import type { ReactNode } from 'react';
import { Header } from './header';

type MaxWidth = '3xl' | '4xl' | '5xl' | '6xl' | '7xl';

interface PageLayoutProps {
  children: ReactNode;
  /** コンテンツ最大幅（デフォルト: 7xl） */
  maxWidth?: MaxWidth;
}

const maxWidthClass: Record<MaxWidth, string> = {
  '3xl': 'max-w-3xl',
  '4xl': 'max-w-4xl',
  '5xl': 'max-w-5xl',
  '6xl': 'max-w-6xl',
  '7xl': 'max-w-7xl',
};

export function PageLayout({ children, maxWidth = '7xl' }: PageLayoutProps) {
  return (
    <div className="min-h-screen bg-surface-0">
      <Header />
      <main
        className={`${maxWidthClass[maxWidth]} mx-auto px-4 sm:px-6 lg:px-8 py-8`}
      >
        <div className="awsui-dark-mode">
          <SpaceBetween size="l">{children}</SpaceBetween>
        </div>
      </main>
    </div>
  );
}
