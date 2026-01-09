/**
 * EmptyState Component
 *
 * HybridNext Design System - Terminal Command Center style
 * Admin ページの空状態表示
 */

import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';

export interface EmptyStateProps {
  /** アイコン（絵文字など） */
  icon: string;
  /** タイトル */
  title: string;
  /** 説明文 */
  description: string;
  /** アクションボタン */
  action?: ReactNode;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: EmptyStateProps) {
  return (
    <Card className="text-center py-12">
      <div className="text-4xl mb-4">{icon}</div>
      <h2 className="text-xl font-semibold text-text-primary mb-2">{title}</h2>
      <p className="text-text-muted mb-6">{description}</p>
      {action}
    </Card>
  );
}
