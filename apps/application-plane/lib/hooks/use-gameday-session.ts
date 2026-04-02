/**
 * GameDay Session Hook
 *
 * useSession + useParams をまとめたカスタム Hook
 * DB からチームメンバーシップを取得する（localStorage はキャッシュとして利用）
 */

'use client';

import { useParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useEffect, useState } from 'react';

export function useGamedaySession() {
  const { data: session, status } = useSession();
  const params = useParams();
  const eventId = params.eventId as string;

  const [dbTeamId, setDbTeamId] = useState('');
  const [dbTeamName, setDbTeamName] = useState('');

  useEffect(() => {
    if (!eventId) return;

    // まずローカルストレージのキャッシュを読む
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(`tenkacloud_gameday_${eventId}`);
      if (stored) {
        try {
          const data = JSON.parse(stored) as {
            teamId?: string;
            teamName?: string;
          };
          if (data.teamId) setDbTeamId(data.teamId);
          if (data.teamName) setDbTeamName(data.teamName);
        } catch {
          // ignore
        }
      }
    }

    // DB からメンバーシップを取得して上書き
    fetch(
      `/api/gameday/teams/my-membership?eventId=${encodeURIComponent(eventId)}`
    )
      .then((res) => res.json())
      .then(
        (data: {
          membership?: { teamId: string; teamName: string } | null;
        }) => {
          if (data.membership) {
            setDbTeamId(data.membership.teamId);
            setDbTeamName(data.membership.teamName);
            // キャッシュを更新
            if (typeof window !== 'undefined') {
              localStorage.setItem(
                `tenkacloud_gameday_${eventId}`,
                JSON.stringify({
                  teamId: data.membership.teamId,
                  teamName: data.membership.teamName,
                })
              );
            }
          }
        }
      )
      .catch(() => {
        // DB 取得失敗時はキャッシュをそのまま使用
      });
  }, [eventId]);

  const sessionTeamId = (session as { teamId?: string } | null)?.teamId ?? '';
  const teamId = dbTeamId || sessionTeamId;
  const teamName =
    dbTeamName || (session as { teamName?: string } | null)?.teamName || '';

  return {
    eventId,
    teamId,
    teamName,
    session,
    isLoading: status === 'loading',
    isAuthenticated: status === 'authenticated',
  };
}
