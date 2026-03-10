/**
 * GameDay Layout
 *
 * タブナビゲーション（6タブ + タイマー + スコア）
 */

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { GameStatusBar } from '@/components/gameday';
import { Header } from '@/components/layout';
import { getTeamDashboard } from '@/lib/api/gameday';
import type { GameState } from '@/lib/api/gameday-types';
import { useGamedaySession } from '@/lib/hooks/use-gameday-session';

const GAMEDAY_API_URL =
  process.env.NEXT_PUBLIC_GAMEDAY_API_URL ||
  'http://localhost:3020/api/gameday';

const tabs = [
  { href: '', label: '司令部', icon: 'Home' },
  { href: '/defense', label: '防衛', icon: 'Shield' },
  { href: '/attack', label: '攻撃', icon: 'Swords' },
  { href: '/alliance', label: '同盟', icon: 'Handshake' },
  { href: '/scoreboard', label: 'スコア', icon: 'Trophy' },
  { href: '/vote', label: '投票', icon: 'Vote' },
] as const;

interface GamedayLayoutProps {
  children: ReactNode;
}

export default function GamedayLayout({ children }: GamedayLayoutProps) {
  const pathname = usePathname();
  const { eventId, teamId } = useGamedaySession();
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [score, setScore] = useState<number | undefined>();

  const basePath = `/gameday/${eventId}`;

  const fetchStatus = useCallback(async () => {
    if (!eventId || !teamId) return;
    try {
      const [statusRes, dashRes] = await Promise.all([
        fetch(
          `${GAMEDAY_API_URL}/admin/game/status?eventId=${encodeURIComponent(eventId)}`
        ).then((r) => (r.ok ? r.json() : null)),
        getTeamDashboard(eventId, teamId).catch(() => null),
      ]);
      if (statusRes) setGameState(statusRes);
      if (dashRes) setScore(dashRes.score);
    } catch {
      // ignore
    }
  }, [eventId, teamId]);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 15000);
    return () => clearInterval(id);
  }, [fetchStatus]);

  const isActive = (tabHref: string) => {
    const full = `${basePath}${tabHref}`;
    if (tabHref === '')
      return pathname === basePath || pathname === `${basePath}/`;
    return pathname.startsWith(full);
  };

  return (
    <div className="min-h-screen bg-surface-0">
      <Header />

      {/* Status Bar */}
      <div className="bg-surface-1 border-b border-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3">
          <GameStatusBar gameState={gameState} score={score} />
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="bg-surface-1 border-b border-border sticky top-16 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <nav className="-mb-px flex space-x-6 overflow-x-auto">
            {tabs.map((tab) => {
              const active = isActive(tab.href);
              return (
                <Link
                  key={tab.href}
                  href={`${basePath}${tab.href}`}
                  className={`py-3 px-1 border-b-2 font-medium text-sm whitespace-nowrap transition-colors ${
                    active
                      ? 'border-hn-accent text-hn-accent'
                      : 'border-transparent text-text-muted hover:text-text-primary hover:border-border'
                  }`}
                >
                  {tab.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </div>

      {/* Page Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {children}
      </main>
    </div>
  );
}
