/**
 * GameDay Session Hook
 *
 * useSession + useParams をまとめたカスタム Hook
 * localStorage からチーム情報を補完する
 */

'use client';

import { useParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useEffect, useState } from 'react';

export function useGamedaySession() {
  const { data: session, status } = useSession();
  const params = useParams();
  const eventId = params.eventId as string;

  const [localTeamId, setLocalTeamId] = useState('');
  const [localTeamName, setLocalTeamName] = useState('');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = localStorage.getItem(`tenkacloud_gameday_${eventId}`);
    if (stored) {
      try {
        const data = JSON.parse(stored) as {
          teamId?: string;
          teamName?: string;
        };
        setLocalTeamId(data.teamId || '');
        setLocalTeamName(data.teamName || '');
      } catch {
        // ignore parse errors
      }
    }
  }, [eventId]);

  const sessionTeamId = (session as { teamId?: string } | null)?.teamId ?? '';
  const teamId = sessionTeamId || localTeamId;
  const teamName =
    (session as { teamName?: string } | null)?.teamName ?? localTeamName;

  return {
    eventId,
    teamId,
    teamName,
    session,
    isLoading: status === 'loading',
    isAuthenticated: status === 'authenticated',
  };
}
