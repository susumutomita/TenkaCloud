/**
 * Alliance Card
 *
 * 同盟カード（承認/破棄ボタン）
 */

'use client';

import { Button, Card, CardContent } from '@/components/ui';
import type { Alliance } from '@/lib/api/gameday-types';
import { AllianceStatusBadge } from './alliance-status-badge';

interface AllianceCardProps {
  alliance: Alliance;
  myTeamId: string;
  onAccept?: () => void;
  onBreak?: () => void;
  loading?: boolean;
}

export function AllianceCard({
  alliance,
  myTeamId,
  onAccept,
  onBreak,
  loading = false,
}: AllianceCardProps) {
  const isIncoming = alliance.targetTeamId === myTeamId;
  const partnerTeamId = isIncoming
    ? alliance.requesterTeamId
    : alliance.targetTeamId;

  const time = new Date(alliance.createdAt).toLocaleDateString('ja-JP', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="font-semibold text-text-primary">
            {partnerTeamId}
          </span>
          <AllianceStatusBadge status={alliance.status} />
        </div>

        <div className="text-xs text-text-muted font-mono">
          {isIncoming ? '受信' : '送信'} - {time}
        </div>

        <div className="flex gap-2">
          {alliance.status === 'PENDING' && isIncoming && (
            <Button
              variant="success"
              size="sm"
              onClick={onAccept}
              loading={loading}
              disabled={loading}
            >
              承認
            </Button>
          )}
          {alliance.status === 'ACTIVE' && (
            <Button
              variant="danger"
              size="sm"
              onClick={onBreak}
              loading={loading}
              disabled={loading}
            >
              破棄
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
