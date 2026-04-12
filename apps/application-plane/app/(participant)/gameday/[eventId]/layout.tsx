/**
 * GameDay Layout
 *
 * Cloudscape Design System — TopNavigation + AppLayout + SideNavigation
 */

'use client';

import AppLayout from '@cloudscape-design/components/app-layout';
import SideNavigation from '@cloudscape-design/components/side-navigation';
import type { SideNavigationProps } from '@cloudscape-design/components/side-navigation';
import TopNavigation from '@cloudscape-design/components/top-navigation';
import '@cloudscape-design/global-styles/index.css';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import {
  getLeaderboard,
  getParticipantGameStatus,
  getTeamDashboard,
} from '@/lib/api/gameday';
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
  const [mounted, setMounted] = useState(false);

  const basePath = `/gameday/${eventId}`;

  useEffect(() => {
    setMounted(true);
  }, []);

  const fetchStatus = useCallback(async () => {
    if (!eventId || !teamId) return;
    try {
      const [statusRes, dashRes, leaderboardRes] = await Promise.all([
        getParticipantGameStatus(eventId).catch(() => null),
        getTeamDashboard(eventId, teamId).catch(() => null),
        getLeaderboard(eventId).catch(() => null),
      ]);
      if (statusRes) setGameState(statusRes);
      if (dashRes) setScore(dashRes.score);
      if (leaderboardRes) {
        const entry = leaderboardRes.leaderboard.find(
          (e) => e.teamId === teamId,
        );
        if (entry) setRank(entry.rank);
      }
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
        {
          type: 'link',
          text: t('gameday.tutorial'),
          href: `${basePath}/tutorial`,
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
      '/tutorial',
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
    <div className="awsui-dark-mode">
      <div id="gameday-top-nav" style={{ position: 'relative', minHeight: 72 }}>
        {mounted ? (
          <>
            <TopNavigation
              identity={{
                href: basePath,
                title: 'TenkaCloud',
                onFollow: (e) => {
                  e.preventDefault();
                  router.push(basePath);
                },
              }}
              utilities={[
                {
                  type: 'button' as const,
                  text: scoreDisplay,
                  disableUtilityCollapse: true,
                },
                {
                  type: 'button' as const,
                  text: rankDisplay,
                  disableUtilityCollapse: true,
                },
                ...(gameState?.isRunning
                  ? [
                      {
                        type: 'button' as const,
                        text: t('gameday.live'),
                        disableUtilityCollapse: true,
                      },
                    ]
                  : []),
                {
                  type: 'menu-dropdown' as const,
                  text: locale.toUpperCase(),
                  ariaLabel:
                    locale === 'ja' ? '言語切り替え' : 'Switch language',
                  items: [
                    { id: 'ja', text: 'JA' },
                    { id: 'en', text: 'EN' },
                  ],
                  onItemClick: (e) => setLocale(e.detail.id as 'ja' | 'en'),
                },
                {
                  type: 'menu-dropdown' as const,
                  text: teamName || teamId || 'Team',
                  iconName: 'user-profile' as const,
                  items: [
                    { id: 'events', text: t('gameday.events') },
                    { id: 'event-detail', text: t('gameday.eventDetail') },
                  ],
                  onItemClick: (e) => {
                    if (e.detail.id === 'events') router.push('/events');
                    if (e.detail.id === 'event-detail')
                      router.push(`/events/${eventId}`);
                  },
                },
              ]}
              i18nStrings={{
                overflowMenuTriggerText: 'その他',
                overflowMenuTitleText: 'すべて',
              }}
            />
            <div
              style={{
                position: 'absolute',
                right: '200px',
                top: '50%',
                transform: 'translateY(-50%)',
                zIndex: 1000,
              }}
            >
              <NotificationPanel />
            </div>
          </>
        ) : null}
      </div>
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
  );
}
