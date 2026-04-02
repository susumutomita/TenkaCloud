/**
 * Attack Card
 *
 * 攻撃カタログカード
 */

'use client';

import { useEffect, useState } from 'react';
import { Button, Card, CardContent } from '@/components/ui';
import type { Attack } from '@/lib/api/gameday-types';
import { AttackTypeBadge } from './attack-type-badge';

interface AttackCardProps {
  attack: Attack;
  purchased?: boolean;
  cooldownUntil?: number;
  onPurchase?: () => void;
  onExecute?: () => void;
  purchasing?: boolean;
  executing?: boolean;
}

export function AttackCard({
  attack,
  purchased = false,
  cooldownUntil,
  onPurchase,
  onExecute,
  purchasing = false,
  executing = false,
}: AttackCardProps) {
  const [cooldownRemaining, setCooldownRemaining] = useState(0);

  useEffect(() => {
    if (!cooldownUntil) {
      setCooldownRemaining(0);
      return;
    }

    function calc() {
      const diff = Math.max(
        0,
        Math.ceil(((cooldownUntil as number) - Date.now()) / 1000),
      );
      setCooldownRemaining(diff);
    }

    calc();
    const id = setInterval(calc, 1000);
    return () => clearInterval(id);
  }, [cooldownUntil]);

  const isCoolingDown = cooldownRemaining > 0;

  return (
    <Card className="flex flex-col">
      <CardContent className="flex-1 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-semibold text-text-primary">{attack.name}</h3>
          <AttackTypeBadge type={attack.attackType} />
        </div>

        <p className="text-sm text-text-secondary line-clamp-2">
          {attack.description}
        </p>

        <div className="grid grid-cols-3 gap-2 text-center text-xs font-mono">
          <div className="bg-surface-2 rounded-[var(--radius-sm)] p-2">
            <div className="text-text-muted">コスト</div>
            <div className="text-hn-warning font-bold">
              {attack.purchaseCost}
            </div>
          </div>
          <div className="bg-surface-2 rounded-[var(--radius-sm)] p-2">
            <div className="text-text-muted">ダメージ</div>
            <div className="text-hn-error font-bold">{attack.damage}</div>
          </div>
          <div className="bg-surface-2 rounded-[var(--radius-sm)] p-2">
            <div className="text-text-muted">報酬</div>
            <div className="text-hn-success font-bold">{attack.reward}</div>
          </div>
        </div>

        {isCoolingDown && (
          <div className="text-center text-sm font-mono text-hn-warning">
            クールダウン: {cooldownRemaining}s
          </div>
        )}
      </CardContent>

      <div className="px-6 pb-4">
        {!purchased ? (
          <Button
            variant="outline"
            size="sm"
            fullWidth
            onClick={onPurchase}
            loading={purchasing}
            disabled={purchasing}
          >
            購入 ({attack.purchaseCost} pts)
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            fullWidth
            onClick={onExecute}
            loading={executing}
            disabled={isCoolingDown || executing}
          >
            {isCoolingDown ? `${cooldownRemaining}s` : '実行'}
          </Button>
        )}
      </div>
    </Card>
  );
}
