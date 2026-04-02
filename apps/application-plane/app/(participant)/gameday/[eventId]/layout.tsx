/**
 * GameDay Layout
 *
 * Cloudscape Design System — AWS GameDay 風 AppLayout + SideNavigation
 * TopNavigation に Score/Rank/Team 表示
 */

'use client';

import AppLayout from '@cloudscape-design/components/app-layout';
import Badge from '@cloudscape-design/components/badge';
import SideNavigation from '@cloudscape-design/components/side-navigation';
import type { SideNavigationProps } from '@cloudscape-design/components/side-navigation';
import TopNavigation from '@cloudscape-design/components/top-navigation';
import '@cloudscape-design/global-styles/index.css';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { GameTimer } from '@/components/gameday';
import { getParticipantGameStatus, getTeamDashboard } from '@/lib/api/gameday';
import type { GameState } from '@/lib/api/gameday-types';
import { useGamedaySession } from '@/lib/hooks/use-gameday-session';

interface GamedayLayoutProps {
  children: ReactNode;
}

export default function GamedayLayout({ children }: GamedayLayoutProps) {
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
        { type: 'link', text: 'Home', href: basePath },
        { type: 'link', text: 'Score events', href: `${basePath}/scoreboard` },
        {
          type: 'link',
          text: 'Scoreboard',
          href: `${basePath}/scoreboard`,
          external: true,
        },
      ],
    },
    {
      type: 'section',
      text: 'Quests',
      items: [
        { type: 'link', text: '防衛', href: `${basePath}/defense` },
        { type: 'link', text: '攻撃', href: `${basePath}/attack` },
        { type: 'link', text: '同盟', href: `${basePath}/alliance` },
      ],
    },
    {
      type: 'section',
      text: 'Tools',
      items: [
        { type: 'link', text: '投票', href: `${basePath}/vote` },
        {
          type: 'link',
          text: 'AWS Console',
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
    for (const s of suffixes) {
      if (pathname.startsWith(`${basePath}${s}`)) return `${basePath}${s}`;
    }
    return basePath;
  })();

  const scoreDisplay =
    score !== undefined ? `Score: ${score.toLocaleString()}` : 'Score: --';
  const rankDisplay = rank !== undefined ? `Rank: ${rank}` : 'Rank: --';

  return (
    <div className="awsui-dark-mode">
      <div id="gameday-top-nav">
        <TopNavigation
          identity={{
            href: basePath,
            title: 'TenkaCloud GameDay',
            onFollow: (e) => {
              e.preventDefault();
              router.push(basePath);
            },
          }}
          utilities={[
            ...(gameState
              ? [
                  {
                    type: 'button' as const,
                    text: gameState.isRunning ? 'LIVE' : 'STOPPED',
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
              type: 'menu-dropdown' as const,
              text: teamName || teamId || 'Team',
              iconName: 'user-profile' as const,
              items: [
                {
                  id: 'events',
                  text: 'イベント一覧',
                  href: '/events',
                },
                {
                  id: 'event-detail',
                  text: 'イベント詳細',
                  href: `/events/${eventId}`,
                },
              ],
            },
          ]}
          i18nStrings={{
            overflowMenuTriggerText: 'その他',
            overflowMenuTitleText: 'すべて',
          }}
        />
      </div>
      <AppLayout
        navigation={
          <SideNavigation
            header={{ text: 'GameDay', href: basePath }}
            activeHref={activeHref}
            items={navItems}
            onFollow={(e) => {
              if (!e.detail.external) {
                e.preventDefault();
                router.push(e.detail.href);
              }
            }}
          />
        }
        toolsHide
        content={children}
        headerSelector="#gameday-top-nav"
        ariaLabels={{
          navigation: 'GameDay メニュー',
          navigationClose: 'ナビゲーションを閉じる',
          navigationToggle: 'ナビゲーションを開く',
        }}
      />
    </div>
  );
}
