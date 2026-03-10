/**
 * Defense Item
 *
 * 受けた攻撃の行コンポーネント
 */

'use client';

import { Badge, Button } from '@/components/ui';
import type { AttackLog } from '@/lib/api/gameday-types';
import { AttackTypeBadge } from './attack-type-badge';

interface DefenseItemProps {
  attack: AttackLog;
  onPurchaseHint?: () => void;
  onReportFix?: () => void;
  hintLoading?: boolean;
  fixLoading?: boolean;
  hint?: string;
}

export function DefenseItem({
  attack,
  onPurchaseHint,
  onReportFix,
  hintLoading = false,
  fixLoading = false,
  hint,
}: DefenseItemProps) {
  const time = new Date(attack.createdAt).toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="flex items-center gap-4 p-4 bg-surface-1 border border-border rounded-[var(--radius)] hover:border-hn-accent/30 transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="font-medium text-text-primary truncate">
            {attack.attackSlug}
          </span>
          <AttackTypeBadge type={attack.success ? 'vulnerability' : 'chaos'} />
          {attack.neutralized && (
            <Badge variant="success" badgeStyle="subtle" size="sm">
              修正済
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs text-text-muted">
          <span className="font-mono">{time}</span>
          <span>ダメージ: {attack.damage}</span>
          <span>攻撃者: {attack.attackerTeamId}</span>
        </div>
        {hint && (
          <div className="mt-2 p-2 bg-hn-info/10 border border-hn-info/30 rounded-[var(--radius-sm)] text-sm text-hn-info">
            {hint}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {!attack.neutralized && (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={onPurchaseHint}
              loading={hintLoading}
              disabled={hintLoading || !!hint}
            >
              ヒント
            </Button>
            <Button
              variant="success"
              size="sm"
              onClick={onReportFix}
              loading={fixLoading}
              disabled={fixLoading}
            >
              修正報告
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
