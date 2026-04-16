/**
 * Attack Type Badge
 *
 * vulnerability / chaos バッジ
 */

import Badge from '@cloudscape-design/components/badge';
import { useI18n } from '@/lib/i18n';
import type { AttackType } from '@/lib/api/gameday-types';

const config: Record<AttackType, { key: string; color: 'red' | 'blue' }> = {
  vulnerability: { key: 'gameday.vulnerability', color: 'red' },
  chaos: { key: 'gameday.chaos', color: 'blue' },
};

export function AttackTypeBadge({ type }: { type: AttackType }) {
  const { t } = useI18n();
  const { key, color } = config[type];
  return <Badge color={color}>{t(key)}</Badge>;
}
