/**
 * Attack Type Badge
 *
 * vulnerability / chaos バッジ
 */

import { Badge } from '@/components/ui';
import type { AttackType } from '@/lib/api/gameday-types';

const config: Record<
  AttackType,
  { label: string; variant: 'danger' | 'purple' }
> = {
  vulnerability: { label: '脆弱性', variant: 'danger' },
  chaos: { label: 'カオス', variant: 'purple' },
};

export function AttackTypeBadge({ type }: { type: AttackType }) {
  const { label, variant } = config[type];
  return (
    <Badge variant={variant} badgeStyle="subtle" size="sm">
      {label}
    </Badge>
  );
}
