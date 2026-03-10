/**
 * GameDay Session Hook
 *
 * useSession + useParams をまとめたカスタム Hook
 */

'use client';

import { useParams } from 'next/navigation';
import { useSession } from 'next-auth/react';

export function useGamedaySession() {
  const { data: session, status } = useSession();
  const params = useParams();

  const eventId = params.eventId as string;
  const teamId = (session as { teamId?: string } | null)?.teamId ?? '';
  const teamName = (session as { teamName?: string } | null)?.teamName ?? '';
  const isLoading = status === 'loading';
  const isAuthenticated = status === 'authenticated';

  return {
    eventId,
    teamId,
    teamName,
    session,
    isLoading,
    isAuthenticated,
  };
}
