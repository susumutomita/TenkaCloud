import AppLayout from "@cloudscape-design/components/app-layout";
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
 * Score は `TeamViewProvider` 経由で `/portal/me` polling 結果を共有 (Home の
 * 累計スコアパネルと同じ source)。Rank は leaderboard 実装後 (#163 follow-up) に
 * 有効化する — それまでは "—" 表示。
 */

const SIDE_NAV_ITEMS: SideNavigationProps.Item[] = [
  {
    type: "section",
    text: "Event",
    items: [
      { type: "link", href: "/", text: "Home" },
      { type: "link", href: "/scoreboard", text: "Scoreboard" },
      { type: "link", href: "/score-events", text: "Score events" },
      { type: "link", href: "/notifications", text: "Notifications" },
    ],
  },
  {
    type: "section",
    text: "Quests",
    items: [{ type: "link", href: "/problems", text: "問題一覧" }],
  },
  // Tools section (SSO Credentials) は Identity Center 連携の ADR が固まるまで
  // 非表示 (Issue #500)。route 自体は placeholder で残置しているので bookmark 経由の
  // 直接アクセスは可能だが、sidebar からは導線を切る。
];

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
    // Rank は leaderboard API 接続前なので placeholder 維持。
    const rank = "—";
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
  }, [auth.session, auth.logout, navigate, teamView.view, config.mode]);

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
            items={SIDE_NAV_ITEMS}
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
