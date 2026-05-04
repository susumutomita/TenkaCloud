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
import type { AppConfig } from "../config";

/**
 * Participant Portal の shell。AWS GameDay の参考画面に倣って TopNavigation +
 * 3 セクション SideNavigation (Event / Quests / Tools) を組み立てる。
 * Score / Rank は scoring backend (別 PR) が繋がるまで placeholder 表示。
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
  {
    type: "section",
    text: "Tools",
    items: [{ type: "link", href: "/tools/sso", text: "SSO Credentials" }],
  },
];

export function ShellLayout({ config, children }: { config: AppConfig; children: ReactNode }) {
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const utilities = useMemo<TopNavigationProps.Utility[]>(() => {
    if (!auth.session) return [];
    const score = "—";
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
  }, [auth.session, auth.logout, navigate]);

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
