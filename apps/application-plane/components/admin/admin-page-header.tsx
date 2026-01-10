/**
 * AdminPageHeader Component
 *
 * HybridNext Design System - Terminal Command Center style
 * Admin ページの共通ヘッダー
 */

import type { ReactNode } from 'react';

export interface AdminPageHeaderProps {
  /** ページタイトル */
  title: string;
  /** 右側に表示するアクション（ボタン等） */
  actions?: ReactNode;
}

export function AdminPageHeader({ title, actions }: AdminPageHeaderProps) {
  return (
    <div className="flex items-center justify-between">
      <h1 className="text-2xl font-bold text-text-primary flex items-center gap-3">
        <span className="text-hn-accent font-mono">&gt;_</span>
        {title}
      </h1>
      {actions}
    </div>
  );
}
