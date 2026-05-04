import AppLayout from "@cloudscape-design/components/app-layout";
import Box from "@cloudscape-design/components/box";
import SideNavigation from "@cloudscape-design/components/side-navigation";
import SpaceBetween from "@cloudscape-design/components/space-between";
import TopNavigation from "@cloudscape-design/components/top-navigation";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";

/**
 * Participant Portal の shell。AWS GameDay の参考画面に倣って:
 *   - TopNavigation: ロゴ + EventTitle + 言語 (将来) + Score / Rank + Team Name + サインアウト
 *   - SideNavigation: Event 系 (Home / Scoreboard / Score events / Notifications) +
 *                    Quests 系 (Problems) + Tools 系 (SSO Credentials)
 *
 * Score / Rank は最初は固定値表示。本物の値は scoring backend (別 PR) が来たら
 * AuthContext / scoring API に差し替える。
 */
export function ShellLayout({ config, children }: { config: AppConfig; children: ReactNode }) {
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const teamName = auth.session?.teamName ?? "(unknown)";
  // TODO: 実 score / rank は scoring backend からくる。今は placeholder。
  const score = "—";
  const rank = "—";

  return (
    <>
      <TopNavigation
        identity={{ href: "/", title: `TenkaCloud — ${config.eventTitle}` }}
        utilities={
          auth.session
            ? [
                {
                  type: "menu-dropdown",
                  text: `Score: ${score}  /  Rank: ${rank}`,
                  iconName: "status-positive",
                  items: [],
                },
                {
                  type: "menu-dropdown",
                  text: teamName,
                  iconName: "user-profile",
                  items: [
                    {
                      id: "logout",
                      text: "サインアウト",
                    },
                  ],
                  onItemClick: ({ detail }) => {
                    if (detail.id === "logout") {
                      auth.logout();
                      navigate("/login");
                    }
                  },
                },
              ]
            : []
        }
      />
      <AppLayout
        navigation={
          <SideNavigation
            activeHref={location.pathname}
            header={{ href: "/", text: "メニュー" }}
            items={[
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
            ]}
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
