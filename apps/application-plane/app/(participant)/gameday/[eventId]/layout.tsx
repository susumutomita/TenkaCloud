/**
 * GameDay Layout
 *
 * Cloudscape Design System — AWS GameDay 風 AppLayout + SideNavigation
 * カスタムヘッダーに Score/Rank/Team 表示
 */

'use client';

import AppLayout from '@cloudscape-design/components/app-layout';
import SideNavigation from '@cloudscape-design/components/side-navigation';
import type { SideNavigationProps } from '@cloudscape-design/components/side-navigation';
import '@cloudscape-design/global-styles/index.css';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { getParticipantGameStatus, getTeamDashboard } from '@/lib/api/gameday';
import type { GameState } from '@/lib/api/gameday-types';
import { useGamedaySession } from '@/lib/hooks/use-gameday-session';
import { NotificationPanel } from '@/components/notifications/notification-panel';
import { useI18n } from '@/lib/i18n';

interface GamedayLayoutProps {
  children: ReactNode;
}

export default function GamedayLayout({ children }: GamedayLayoutProps) {
  const { locale, setLocale, t } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const { eventId, teamId, teamName } = useGamedaySession();
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [score, setScore] = useState<number | undefined>();
  const [rank, setRank] = useState<number | undefined>();
  const [awsConsoleLoading, setAwsConsoleLoading] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const basePath = `/gameday/${eventId}`;

  const fetchStatus = useCallback(async () => {
    if (!eventId || !teamId) return;
    try {
      const [statusRes, dashRes] = await Promise.all([
        getParticipantGameStatus(eventId).catch(() => null),
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

  const navItems: SideNavigationProps.Item[] = [
    {
      type: 'section',
      text: 'Event',
      items: [
        { type: 'link', text: t('gameday.home'), href: basePath },
        {
          type: 'link',
          text: t('gameday.scoreboard'),
          href: `${basePath}/scoreboard`,
        },
      ],
    },
    {
      type: 'section',
      text: 'Battle',
      items: [
        {
          type: 'link',
          text: t('gameday.defense'),
          href: `${basePath}/defense`,
        },
        { type: 'link', text: t('gameday.attack'), href: `${basePath}/attack` },
        {
          type: 'link',
          text: t('gameday.alliance'),
          href: `${basePath}/alliance`,
        },
      ],
    },
    {
      type: 'section',
      text: 'Tools',
      items: [
        { type: 'link', text: t('gameday.voteNav'), href: `${basePath}/vote` },
        {
          type: 'link',
          text: awsConsoleLoading
            ? `${t('gameday.awsConsole')}...`
            : t('gameday.awsConsole'),
          href: `${basePath}/aws-console`,
        },
      ],
    },
  ];

  const openAwsConsole = useCallback(async () => {
    if (!eventId || awsConsoleLoading) return;
    setAwsConsoleLoading(true);
    try {
      const response = await fetch(
        `/api/participant/events/${encodeURIComponent(eventId)}/aws-console`,
      );
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        console.error('AWS Console error:', data.error);
        return;
      }
      const data = (await response.json()) as { url: string };
      window.open(data.url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      console.error('AWS Console fetch error:', err);
    } finally {
      setAwsConsoleLoading(false);
    }
  }, [eventId, awsConsoleLoading]);

  const activeHref = (() => {
    if (pathname === basePath || pathname === `${basePath}/`) return basePath;
    const suffixes = [
      '/scoreboard',
      '/defense',
      '/attack',
      '/alliance',
      '/vote',
    ];
    for (const suffix of suffixes) {
      if (pathname.startsWith(`${basePath}${suffix}`))
        return `${basePath}${suffix}`;
    }
    return basePath;
  })();

  const scoreDisplay =
    score !== undefined
      ? `${t('gameday.score')}: ${score.toLocaleString()}`
      : `${t('gameday.score')}: --`;
  const rankDisplay =
    rank !== undefined
      ? `${t('gameday.rank')}: ${rank}`
      : `${t('gameday.rank')}: --`;

  return (
    <>
      <div id="gameday-top-nav">
        <header className="bg-surface-1 border-b border-border sticky top-0 z-50 backdrop-blur-sm bg-opacity-95">
          <div className="px-4 sm:px-6">
            <div className="flex justify-between items-center h-16">
              {/* Logo */}
              <Link
                href={basePath}
                className="flex items-center space-x-2"
                onClick={(e) => {
                  e.preventDefault();
                  router.push(basePath);
                }}
              >
                <div className="w-8 h-8 bg-hn-accent rounded-lg flex items-center justify-center shadow-brutal-sm">
                  <span className="text-surface-0 font-black text-lg">T</span>
                </div>
                <span className="font-bold text-xl text-text-primary">
                  TenkaCloud
                </span>
                <span className="hidden sm:block text-sm text-text-secondary font-medium">
                  {t('gameday.title')}
                </span>
              </Link>

              {/* Score / Rank / Status badges */}
              <div className="hidden md:flex items-center gap-3">
                {gameState && (
                  <span
                    className={`text-xs font-bold px-2 py-1 rounded-full ${gameState.isRunning ? 'bg-green-500 text-white' : 'bg-surface-2 text-text-secondary'}`}
                  >
                    {gameState.isRunning
                      ? t('gameday.live')
                      : t('gameday.stopped')}
                  </span>
                )}
                {gameState?.scoreWeight === 'high' && (
                  <span className="text-xs font-bold px-2 py-1 rounded-full bg-hn-accent text-white">
                    2x SCORE
                  </span>
                )}
                <span className="text-sm text-text-secondary">
                  {scoreDisplay}
                </span>
                {rank !== undefined && (
                  <span className="text-sm text-text-secondary">
                    {rankDisplay}
                  </span>
                )}
              </div>

              {/* Right side: notifications + locale + team */}
              <div className="flex items-center gap-3">
                <NotificationPanel />

                <div className="hidden sm:flex items-center gap-2">
                  <button
                    type="button"
                    className={`text-sm ${locale === 'ja' ? 'text-text-primary' : 'text-text-muted'}`}
                    onClick={() => setLocale('ja')}
                  >
                    JA
                  </button>
                  <span className="text-text-muted">/</span>
                  <button
                    type="button"
                    className={`text-sm ${locale === 'en' ? 'text-text-primary' : 'text-text-muted'}`}
                    onClick={() => setLocale('en')}
                  >
                    EN
                  </button>
                </div>

                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setIsMenuOpen(!isMenuOpen)}
                    className="flex items-center space-x-2 text-text-secondary hover:text-text-primary transition-colors"
                    aria-expanded={isMenuOpen}
                    aria-haspopup="true"
                  >
                    <div className="w-8 h-8 bg-hn-accent rounded-full flex items-center justify-center text-surface-0 font-medium">
                      {(teamName || teamId || 'T').charAt(0).toUpperCase()}
                    </div>
                    <span className="hidden sm:block font-medium text-sm">
                      {teamName || teamId || 'Team'}
                    </span>
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 9l-7 7-7-7"
                      />
                    </svg>
                  </button>

                  {isMenuOpen && (
                    <div className="absolute right-0 mt-2 w-48 bg-surface-elevated rounded-lg shadow-lg py-1 border border-border z-50">
                      <Link
                        href="/events"
                        className="block px-4 py-2 text-sm text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors"
                        onClick={() => setIsMenuOpen(false)}
                      >
                        {t('gameday.events')}
                      </Link>
                      <Link
                        href={`/events/${eventId}`}
                        className="block px-4 py-2 text-sm text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors"
                        onClick={() => setIsMenuOpen(false)}
                      >
                        {t('gameday.eventDetail')}
                      </Link>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </header>
      </div>
      <div className="awsui-dark-mode">
        <AppLayout
          navigation={
            <SideNavigation
              header={{ text: t('gameday.title'), href: basePath }}
              activeHref={activeHref}
              items={navItems}
              onFollow={(event) => {
                event.preventDefault();
                if (event.detail.href === `${basePath}/aws-console`) {
                  openAwsConsole();
                } else if (!event.detail.external) {
                  router.push(event.detail.href);
                }
              }}
            />
          }
          toolsHide
          content={children}
          headerSelector="#gameday-top-nav"
          ariaLabels={{
            navigation: t('gameday.menu'),
            navigationClose:
              locale === 'ja' ? 'ナビゲーションを閉じる' : 'Close navigation',
            navigationToggle:
              locale === 'ja' ? 'ナビゲーションを開く' : 'Open navigation',
          }}
        />
      </div>
    </>
  );
}
