/**
 * GameDay Layout
 *
 * Cloudscape Design System — AWS GameDay 風 AppLayout + SideNavigation
 * TopNavigation に Score/Rank/Team 表示
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
import { getParticipantGameStatus, getTeamDashboard } from '@/lib/api/gameday';
import type { GameState } from '@/lib/api/gameday-types';
import { useGamedaySession } from '@/lib/hooks/use-gameday-session';
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
          text: t('gameday.awsConsole'),
          href: 'https://console.aws.amazon.com',
          external: true,
        },
      ],
    },
  ];

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
    <div className="awsui-dark-mode">
      <div id="gameday-top-nav">
        <TopNavigation
          identity={{
            href: basePath,
            title: `TenkaCloud ${t('gameday.title')}`,
            onFollow: (event) => {
              event.preventDefault();
              router.push(basePath);
            },
          }}
          utilities={[
            ...(gameState
              ? [
                  {
                    type: 'button' as const,
                    text: gameState.isRunning
                      ? t('gameday.live')
                      : t('gameday.stopped'),
                    disableUtilityCollapse: true,
                  },
                ]
              : []),
            ...(gameState?.scoreWeight === 'high'
              ? [
                  {
                    type: 'button' as const,
                    text: '2x SCORE',
                    disableUtilityCollapse: true,
                  },
                ]
              : []),
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
            {
              type: 'button' as const,
              text: locale.toUpperCase(),
              onClick: () => setLocale(locale === 'ja' ? 'en' : 'ja'),
              disableUtilityCollapse: true,
            },
            {
              type: 'menu-dropdown' as const,
              text: teamName || teamId || 'Team',
              iconName: 'user-profile' as const,
              items: [
                {
                  id: 'events',
                  text: t('gameday.events'),
                  href: '/events',
                },
                {
                  id: 'event-detail',
                  text: t('gameday.eventDetail'),
                  href: `/events/${eventId}`,
                },
              ],
            },
          ]}
          i18nStrings={{
            overflowMenuTriggerText: locale === 'ja' ? 'その他' : 'More',
            overflowMenuTitleText: locale === 'ja' ? 'すべて' : 'All',
          }}
        />
      </div>
      <AppLayout
        navigation={
          <SideNavigation
            header={{ text: t('gameday.title'), href: basePath }}
            activeHref={activeHref}
            items={navItems}
            onFollow={(event) => {
              if (!event.detail.external) {
                event.preventDefault();
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
