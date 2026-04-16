/**
 * Alliance Status Badge
 *
 * PENDING / ACTIVE バッジ
 */

import Badge from '@cloudscape-design/components/badge';
import { useI18n } from '@/lib/i18n';
import type { AllianceStatus } from '@/lib/api/gameday-types';

const config: Record<AllianceStatus, { key: string; color: 'blue' | 'green' }> =
  {
    PENDING: { key: 'gameday.pending', color: 'blue' },
    ACTIVE: { key: 'gameday.activeBadge', color: 'green' },
  };

export function AllianceStatusBadge({ status }: { status: AllianceStatus }) {
  const { t } = useI18n();
  const { key, color } = config[status];
  return <Badge color={color}>{t(key)}</Badge>;
}
