/**
 * Alliance Status Badge
 *
 * PENDING / ACTIVE バッジ
 */

import { Badge } from '@/components/ui';
import type { AllianceStatus } from '@/lib/api/gameday-types';

const config: Record<
  AllianceStatus,
  { label: string; variant: 'warning' | 'success' }
> = {
  PENDING: { label: '保留中', variant: 'warning' },
  ACTIVE: { label: 'アクティブ', variant: 'success' },
};

export function AllianceStatusBadge({ status }: { status: AllianceStatus }) {
  const { label, variant } = config[status];
  return (
    <Badge variant={variant} badgeStyle="subtle" size="sm" dot>
      {label}
    </Badge>
  );
}
