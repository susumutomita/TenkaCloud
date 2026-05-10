import AppLayout from "@cloudscape-design/components/app-layout";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import SideNavigation, {
  type SideNavigationProps,
} from "@cloudscape-design/components/side-navigation";
import SpaceBetween from "@cloudscape-design/components/space-between";
import TopNavigation, {
  type TopNavigationProps,
} from "@cloudscape-design/components/top-navigation";
import { type ReactNode, useMemo } from "react";
import { useLocation, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { TeamViewProvider, useTeamView } from "../auth/TeamViewProvider";
import type { AppConfig } from "../config";

/**
 * Participant Portal の shell。AWS GameDay の参考画面に倣って TopNavigation +
 * 3 セクション SideNavigation (Event / Quests / Tools) を組み立てる。
 *
 * Score / Rank はどちらも `TeamViewProvider` 経由で `/portal/me` + `/portal/leaderboard`
 * の polling 結果を共有 (Home の累計スコアパネル / Scoreboard と同 source)。Rank は
 * 自チーム (`isMyTeam`) の rank / total entries で表示。Phase 1 以前の旧 deployment
 * (eventId 無し) は leaderboard 不能なので "—" で fallback。
 */

/**
 * SideNavigation items (notifications 未読 badge 用に動的構築)。`unread` を渡して
 * `info` バッジに件数を出す。> 99 は "99+" にクランプして badge 横幅を一定にする。
 */
function buildSideNavItems(unread: number): SideNavigationProps.Item[] {
  const notificationsLink: SideNavigationProps.Link = {
    type: "link",
    href: "/notifications",
    text: "Notifications",
    info:
      unread > 0 ? <Badge color="red">{unread > 99 ? "99+" : String(unread)}</Badge> : undefined,
  };
  return [
    {
      type: "section",
      text: "Event",
      items: [
        { type: "link", href: "/", text: "Home" },
        { type: "link", href: "/scoreboard", text: "Scoreboard" },
        { type: "link", href: "/score-events", text: "Score events" },
        notificationsLink,
      ],
    },
    {
      type: "section",
      text: "Quests",
      items: [{ type: "link", href: "/problems", text: "問題一覧" }],
    },
    {
      type: "section",
      text: "Tools",
      items: [{ type: "link", href: "/tools/sso", text: "SSO Credentials" }],
    },
  ];
}

export function ShellLayout({ config, children }: { config: AppConfig; children: ReactNode }) {
  return (
    <TeamViewProvider config={config}>
      <ShellInner config={config}>{children}</ShellInner>
    </TeamViewProvider>
  );
}

function ShellInner({ config, children }: { config: AppConfig; children: ReactNode }) {
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const teamView = useTeamView();

  const utilities = useMemo<TopNavigationProps.Utility[]>(() => {
    if (!auth.session) return [];
    // Score: backend mode のときだけ実値、未取得なら "…"、dev-mock なら "—"。
    const totalScore = teamView.view
      ? teamView.view.problems.reduce((sum, p) => sum + p.score, 0)
      : null;
    const score =
      config.mode === "backend" ? (totalScore !== null ? `${totalScore} pt` : "…") : "—";
    // Rank: leaderboard.entries.find(isMyTeam) の rank / 全 entries 数。
    // Phase 1 以前 (eventId 無し) は leaderboardNoEvent → "—"、未取得は "…"。
    const myEntry = teamView.leaderboard?.entries.find((e) => e.isMyTeam);
    const totalEntries = teamView.leaderboard?.entries.length;
    const rank =
      config.mode !== "backend"
        ? "—"
        : teamView.leaderboardNoEvent
          ? "—"
          : myEntry && totalEntries
            ? `${myEntry.rank}/${totalEntries}`
            : "…";
    return [
      {
        type: "menu-dropdown",
        text: `Score: ${score}  /  Rank: ${rank}`,
        iconName: "status-positive",
        items: [],
      },
      {
        type: "menu-dropdown",
        text: auth.session.teamName,
        iconName: "user-profile",
        items: [{ id: "logout", text: "サインアウト" }],
        onItemClick: ({ detail }) => {
          if (detail.id === "logout") {
            auth.logout();
            navigate("/login");
          }
        },
      },
    ];
  }, [
    auth.session,
    auth.logout,
    navigate,
    teamView.view,
    teamView.leaderboard,
    teamView.leaderboardNoEvent,
    config.mode,
  ]);

  const sideNavItems = useMemo(
    () => buildSideNavItems(teamView.unreadNotificationCount),
    [teamView.unreadNotificationCount],
  );

  return (
    <>
      <TopNavigation
        identity={{ href: "/", title: `TenkaCloud — ${config.eventTitle}` }}
        utilities={utilities}
      />
      <AppLayout
        navigation={
          <SideNavigation
            activeHref={location.pathname}
            header={{ href: "/", text: "メニュー" }}
            items={sideNavItems}
            onFollow={(e) => {
              if (!e.detail.external) {
                e.preventDefault();
                navigate(e.detail.href);
              }
            }}
          />
        }
        content={
          <SpaceBetween size="m">
            {auth.session === null ? (
              <Box variant="strong" color="text-status-warning">
                セッションがありません。再ログインしてください。
              </Box>
            ) : null}
            {children}
          </SpaceBetween>
        }
        toolsHide
      />
    </>
  );
}
