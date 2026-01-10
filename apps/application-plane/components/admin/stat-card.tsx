/**
 * StatCard Component
 *
 * HybridNext Design System - Terminal Command Center style
 * Admin ページの統計カード
 */

import { Card, CardContent } from '@/components/ui/card';

export interface StatCardProps {
  /** ラベル */
  label: string;
  /** 値 */
  value: string | number;
  /** 値の色クラス（例: 'text-hn-accent', 'text-hn-success'） */
  valueClassName?: string;
}

export function StatCard({
  label,
  value,
  valueClassName = 'text-text-primary',
}: StatCardProps) {
  const displayValue =
    typeof value === 'number' ? value.toLocaleString() : value;

  return (
    <Card>
      <CardContent className="p-6">
        <div className="text-sm font-medium text-text-muted">{label}</div>
        <div className={`text-3xl font-bold mt-1 font-mono ${valueClassName}`}>
          {displayValue}
        </div>
      </CardContent>
    </Card>
  );
}
